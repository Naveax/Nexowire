import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import type { ControlPlaneIdentity } from './control-plane-service.js';

const SESSION_VERSION = 1;
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_STATE_TTL_SECONDS = 10 * 60;

interface SessionPayload {
  v: 1;
  kind: 'session';
  accountId: string;
  role: ControlPlaneIdentity['role'];
  iat: number;
  exp: number;
}

interface OAuthStatePayload {
  v: 1;
  kind: 'oauth-state';
  provider: string;
  next: string;
  iat: number;
  exp: number;
}

function requireSecret(secret: string): string {
  if (secret.length < 32) {
    throw new Error('Session signing secret must be at least 32 characters.');
  }
  return secret;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', requireSecret(secret))
    .update(encoded, 'utf8')
    .digest('base64url');
}

function verifySigned<T>(
  token: string,
  secret: string,
): T | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const encoded = parts[0];
  const signature = parts[1];
  if (!encoded || !signature) return null;

  const expected = Buffer.from(sign(encoded, secret), 'base64url');
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return null;
  }

  try {
    return decode<T>(encoded);
  } catch {
    return null;
  }
}

function safeNext(input: string | undefined): string {
  const value = input?.trim() || '/';
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.length > 512
  ) {
    return '/';
  }
  return value;
}

export function issueSessionToken(
  identity: ControlPlaneIdentity,
  secret: string,
  options: {
    now?: Date;
    ttlSeconds?: number;
  } = {},
): string {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 90 * 24 * 60 * 60) {
    throw new Error('Session TTL must be between 60 seconds and 90 days.');
  }

  const payload: SessionPayload = {
    v: SESSION_VERSION,
    kind: 'session',
    accountId: identity.accountId,
    role: identity.role,
    iat: now,
    exp: now + ttl,
  };
  const encoded = encode(payload);
  return encoded + '.' + sign(encoded, secret);
}

export function verifySessionToken(
  token: string,
  secret: string,
  now = new Date(),
): ControlPlaneIdentity | null {
  const payload = verifySigned<SessionPayload>(token, secret);
  if (
    !payload ||
    payload.v !== SESSION_VERSION ||
    payload.kind !== 'session' ||
    typeof payload.accountId !== 'string' ||
    !['user', 'admin', 'service'].includes(payload.role) ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= Math.floor(now.getTime() / 1000)
  ) {
    return null;
  }
  return {
    accountId: payload.accountId,
    role: payload.role,
  };
}

export function issueOAuthState(
  provider: string,
  next: string | undefined,
  secret: string,
  options: {
    now?: Date;
    ttlSeconds?: number;
  } = {},
): string {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_STATE_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 60) {
    throw new Error('OAuth state TTL must be between 60 and 1800 seconds.');
  }

  const payload: OAuthStatePayload = {
    v: SESSION_VERSION,
    kind: 'oauth-state',
    provider,
    next: safeNext(next),
    iat: now,
    exp: now + ttl,
  };
  const encoded = encode(payload);
  return encoded + '.' + sign(encoded, secret);
}

export function verifyOAuthState(
  token: string,
  provider: string,
  secret: string,
  now = new Date(),
): { next: string } | null {
  const payload = verifySigned<OAuthStatePayload>(token, secret);
  if (
    !payload ||
    payload.v !== SESSION_VERSION ||
    payload.kind !== 'oauth-state' ||
    payload.provider !== provider ||
    payload.exp <= Math.floor(now.getTime() / 1000)
  ) {
    return null;
  }
  return { next: safeNext(payload.next) };
}

export function sessionCookie(
  token: string,
  maxAgeSeconds = DEFAULT_SESSION_TTL_SECONDS,
): string {
  return [
    'nwx_session=' + token,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + String(maxAgeSeconds),
  ].join('; ');
}

export function clearSessionCookie(): string {
  return [
    'nwx_session=',
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function sessionTokenFromRequest(
  request: Request,
): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('nwx_session=')) {
      return trimmed.slice('nwx_session='.length) || null;
    }
  }
  return null;
}
