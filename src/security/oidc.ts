import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import {
  normalizeToolPatterns,
} from './tool-authorization.js';
import type {
  CredentialRole,
} from './credential-store.js';

export interface ExternalIdentityGrant {
  issuer: string;
  subject: string;
  role: CredentialRole;
  allowedTools?: string[];
  allowedDeviceIds?: string[];
  allowedRoutingPolicies?: string[];
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri?: string;
  roleClaim?: string;
  toolsClaim?: string;
  deviceIdsClaim?: string;
  routingPoliciesClaim?: string;
  clockSkewSeconds?: number;
  cacheTtlMs?: number;
  allowInsecureHttp?: boolean;
  now?: () => number;
  fetchFn?: typeof fetch;
}

interface JwtHeader {
  alg: 'RS256' | 'ES256';
  kid: string;
  typ?: string;
}

interface JwtClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  [key: string]: unknown;
}

interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
}

interface JsonWebKeySet {
  keys: JsonWebKey[];
}

interface CachedJwks {
  expiresAt: number;
  keys: Map<string, JsonWebKey>;
}

export class OidcVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OidcVerificationError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringClaim(
  claims: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined;
}

function stringArrayClaim(
  claims: Record<string, unknown>,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new OidcVerificationError(
      'OIDC_CLAIM_TYPE_INVALID',
      `OIDC claim "${name}" must be an array of strings.`,
    );
  }
  if (value.length === 0 || value.length > maxItems) {
    throw new OidcVerificationError(
      'OIDC_CLAIM_SIZE_INVALID',
      `OIDC claim "${name}" has an invalid number of entries.`,
    );
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length < 1 ||
      item.length > maxLength
    ) {
      throw new OidcVerificationError(
        'OIDC_CLAIM_VALUE_INVALID',
        `OIDC claim "${name}" contains an invalid string value.`,
      );
    }
    if (seen.has(item)) continue;
    seen.add(item);
    output.push(item);
  }
  return output;
}

function parseRole(value: unknown): CredentialRole {
  if (value === undefined) return 'user';
  if (
    value === 'user' ||
    value === 'operator' ||
    value === 'admin'
  ) {
    return value;
  }
  throw new OidcVerificationError(
    'OIDC_ROLE_INVALID',
    'OIDC role claim must be user, operator, or admin.',
  );
}

function parseBase64UrlJson<T>(
  segment: string,
  label: string,
  maxBytes: number,
): T {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(segment, 'base64url');
  } catch {
    throw new OidcVerificationError(
      'OIDC_TOKEN_MALFORMED',
      `OIDC JWT ${label} is not valid base64url.`,
    );
  }
  if (bytes.length < 2 || bytes.length > maxBytes) {
    throw new OidcVerificationError(
      'OIDC_TOKEN_MALFORMED',
      `OIDC JWT ${label} is outside the allowed size.`,
    );
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new OidcVerificationError(
      'OIDC_TOKEN_MALFORMED',
      `OIDC JWT ${label} is not valid JSON.`,
    );
  }
}

function validateHeader(value: unknown): JwtHeader {
  const input = record(value);
  if (!input) {
    throw new OidcVerificationError(
      'OIDC_TOKEN_MALFORMED',
      'OIDC JWT header must be an object.',
    );
  }
  if (input.alg !== 'RS256' && input.alg !== 'ES256') {
    throw new OidcVerificationError(
      'OIDC_ALG_UNSUPPORTED',
      'OIDC JWT algorithm must be RS256 or ES256.',
      { alg: input.alg },
    );
  }
  if (
    typeof input.kid !== 'string' ||
    input.kid.length < 1 ||
    input.kid.length > 256
  ) {
    throw new OidcVerificationError(
      'OIDC_KID_INVALID',
      'OIDC JWT must contain a bounded non-empty kid.',
    );
  }
  if (
    input.typ !== undefined &&
    (typeof input.typ !== 'string' || input.typ.length > 64)
  ) {
    throw new OidcVerificationError(
      'OIDC_TOKEN_MALFORMED',
      'OIDC JWT typ header is invalid.',
    );
  }
  return {
    alg: input.alg,
    kid: input.kid,
    ...(typeof input.typ === 'string'
      ? { typ: input.typ }
      : {}),
  };
}

function validateClaims(value: unknown): JwtClaims {
  const input = record(value);
  if (!input) {
    throw new OidcVerificationError(
      'OIDC_TOKEN_MALFORMED',
      'OIDC JWT claims must be an object.',
    );
  }
  if (
    typeof input.iss !== 'string' ||
    typeof input.sub !== 'string' ||
    input.sub.length < 1 ||
    input.sub.length > 512 ||
    typeof input.exp !== 'number' ||
    !Number.isFinite(input.exp)
  ) {
    throw new OidcVerificationError(
      'OIDC_CLAIMS_INVALID',
      'OIDC JWT must contain valid iss, sub, and exp claims.',
    );
  }
  if (
    !(
      typeof input.aud === 'string' ||
      (Array.isArray(input.aud) &&
        input.aud.length > 0 &&
        input.aud.length <= 32 &&
        input.aud.every(
          (entry) =>
            typeof entry === 'string' &&
            entry.length > 0 &&
            entry.length <= 512,
        ))
    )
  ) {
    throw new OidcVerificationError(
      'OIDC_CLAIMS_INVALID',
      'OIDC JWT aud claim must be a string or bounded string array.',
    );
  }
  for (const name of ['nbf', 'iat'] as const) {
    const claim = input[name];
    if (
      claim !== undefined &&
      (typeof claim !== 'number' || !Number.isFinite(claim))
    ) {
      throw new OidcVerificationError(
        'OIDC_CLAIMS_INVALID',
        `OIDC JWT ${name} claim must be numeric.`,
      );
    }
  }
  return input as unknown as JwtClaims;
}

function normalizedIssuer(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OidcVerificationError(
      'OIDC_CONFIG_INVALID',
      'OIDC issuer must be an absolute URL.',
    );
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new OidcVerificationError(
      'OIDC_CONFIG_INVALID',
      'OIDC issuer must use HTTP(S).',
    );
  }
  return trimmed;
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return (
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '::1'
  );
}

function assertTrustedHttpUrl(
  value: string,
  label: string,
  allowInsecureHttp: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcVerificationError(
      'OIDC_CONFIG_INVALID',
      `${label} must be an absolute URL.`,
    );
  }

  if (url.protocol === 'https:') return url;
  if (
    url.protocol === 'http:' &&
    (allowInsecureHttp || isLoopbackHostname(url.hostname))
  ) {
    return url;
  }
  throw new OidcVerificationError(
    'OIDC_INSECURE_URL',
    `${label} must use HTTPS unless explicitly allowed for a trusted development environment.`,
    { url: value },
  );
}

function audienceMatches(
  actual: string | string[],
  expected: string,
): boolean {
  return Array.isArray(actual)
    ? actual.includes(expected)
    : actual === expected;
}

function keyMatchesAlgorithm(
  jwk: JsonWebKey,
  algorithm: JwtHeader['alg'],
): boolean {
  if (algorithm === 'RS256') {
    return jwk.kty === 'RSA';
  }
  return (
    jwk.kty === 'EC' &&
    (jwk.crv === undefined || jwk.crv === 'P-256')
  );
}

export class OidcVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUri?: string;
  private readonly roleClaim: string;
  private readonly toolsClaim: string;
  private readonly deviceIdsClaim: string;
  private readonly routingPoliciesClaim: string;
  private readonly clockSkewSeconds: number;
  private readonly cacheTtlMs: number;
  private readonly allowInsecureHttp: boolean;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private discoveryCache?: {
    expiresAt: number;
    jwksUri: string;
  };
  private jwksCache?: CachedJwks;
  private refreshPromise?: Promise<CachedJwks>;

  constructor(options: OidcVerifierOptions) {
    this.issuer = normalizedIssuer(options.issuer);
    if (
      !options.audience.trim() ||
      options.audience.length > 512
    ) {
      throw new OidcVerificationError(
        'OIDC_CONFIG_INVALID',
        'OIDC audience must be a non-empty bounded string.',
      );
    }
    this.audience = options.audience.trim();
    this.jwksUri = options.jwksUri?.trim() || undefined;
    this.roleClaim = options.roleClaim?.trim() || 'nexowire_role';
    this.toolsClaim = options.toolsClaim?.trim() || 'nexowire_tools';
    this.deviceIdsClaim =
      options.deviceIdsClaim?.trim() || 'nexowire_device_ids';
    this.routingPoliciesClaim =
      options.routingPoliciesClaim?.trim() ||
      'nexowire_routing_policies';
    this.clockSkewSeconds = Math.min(
      300,
      Math.max(0, options.clockSkewSeconds ?? 60),
    );
    this.cacheTtlMs = Math.min(
      3_600_000,
      Math.max(10_000, options.cacheTtlMs ?? 300_000),
    );
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetchFn ?? fetch;

    assertTrustedHttpUrl(
      this.issuer,
      'OIDC issuer',
      this.allowInsecureHttp,
    );
    if (this.jwksUri) {
      assertTrustedHttpUrl(
        this.jwksUri,
        'OIDC JWKS URI',
        this.allowInsecureHttp,
      );
    }
  }

  async verifyBearerHeader(
    authorization: string | undefined,
  ): Promise<ExternalIdentityGrant | undefined> {
    if (!authorization) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const token = match?.[1]?.trim();
    if (!token) return undefined;
    return await this.verify(token);
  }

  async verify(token: string): Promise<ExternalIdentityGrant> {
    if (token.length < 32 || token.length > 32_768) {
      throw new OidcVerificationError(
        'OIDC_TOKEN_MALFORMED',
        'OIDC JWT is outside the allowed size.',
      );
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new OidcVerificationError(
        'OIDC_TOKEN_MALFORMED',
        'OIDC JWT must contain exactly three compact segments.',
      );
    }

    const header = validateHeader(
      parseBase64UrlJson<unknown>(parts[0]!, 'header', 8_192),
    );
    const claims = validateClaims(
      parseBase64UrlJson<unknown>(parts[1]!, 'payload', 24_576),
    );
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.length < 32 || signature.length > 1024) {
      throw new OidcVerificationError(
        'OIDC_TOKEN_MALFORMED',
        'OIDC JWT signature is outside the allowed size.',
      );
    }

    if (claims.iss.replace(/\/+$/, '') !== this.issuer) {
      throw new OidcVerificationError(
        'OIDC_ISSUER_MISMATCH',
        'OIDC JWT issuer does not match configured issuer.',
      );
    }
    if (!audienceMatches(claims.aud, this.audience)) {
      throw new OidcVerificationError(
        'OIDC_AUDIENCE_MISMATCH',
        'OIDC JWT audience does not include configured audience.',
      );
    }

    const nowSeconds = Math.floor(this.now() / 1000);
    const skew = this.clockSkewSeconds;
    if (claims.exp <= nowSeconds - skew) {
      throw new OidcVerificationError(
        'OIDC_TOKEN_EXPIRED',
        'OIDC JWT is expired.',
      );
    }
    if (
      claims.nbf !== undefined &&
      claims.nbf > nowSeconds + skew
    ) {
      throw new OidcVerificationError(
        'OIDC_TOKEN_NOT_ACTIVE',
        'OIDC JWT is not active yet.',
      );
    }
    if (
      claims.iat !== undefined &&
      claims.iat > nowSeconds + skew
    ) {
      throw new OidcVerificationError(
        'OIDC_TOKEN_ISSUED_IN_FUTURE',
        'OIDC JWT iat is unreasonably far in the future.',
      );
    }

    const key = await this.resolveKey(header.kid, header.alg);
    const signingInput = Buffer.from(
      parts[0]! + '.' + parts[1]!,
      'ascii',
    );
    const verified =
      header.alg === 'RS256'
        ? verifySignature(
            'RSA-SHA256',
            signingInput,
            key,
            signature,
          )
        : verifySignature(
            'sha256',
            signingInput,
            {
              key,
              dsaEncoding: 'ieee-p1363',
            },
            signature,
          );
    if (!verified) {
      throw new OidcVerificationError(
        'OIDC_SIGNATURE_INVALID',
        'OIDC JWT signature verification failed.',
      );
    }

    const raw = claims as Record<string, unknown>;
    const role = parseRole(raw[this.roleClaim]);
    const tools = stringArrayClaim(
      raw,
      this.toolsClaim,
      256,
      128,
    );
    const allowedTools = tools
      ? normalizeToolPatterns(tools)
      : undefined;
    const allowedDeviceIds = stringArrayClaim(
      raw,
      this.deviceIdsClaim,
      256,
      128,
    )?.sort();
    const routes = stringArrayClaim(
      raw,
      this.routingPoliciesClaim,
      128,
      64,
    );
    const allowedRoutingPolicies = routes?.map((value) => {
      const normalized = value.trim().toLowerCase();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)
      ) {
        throw new OidcVerificationError(
          'OIDC_ROUTE_SCOPE_INVALID',
          'OIDC routing policy scope contains an invalid name.',
        );
      }
      return normalized;
    }).sort();

    return {
      issuer: this.issuer,
      subject: claims.sub,
      role,
      ...(allowedTools ? { allowedTools } : {}),
      ...(allowedDeviceIds
        ? { allowedDeviceIds }
        : {}),
      ...(allowedRoutingPolicies
        ? { allowedRoutingPolicies }
        : {}),
    };
  }

  private async resolveKey(
    kid: string,
    algorithm: JwtHeader['alg'],
  ): Promise<KeyObject> {
    let jwks = await this.getJwks(false);
    let key = jwks.keys.get(kid);
    if (!key || !keyMatchesAlgorithm(key, algorithm)) {
      jwks = await this.getJwks(true);
      key = jwks.keys.get(kid);
    }
    if (!key) {
      throw new OidcVerificationError(
        'OIDC_KEY_NOT_FOUND',
        'OIDC JWT kid was not found in the current JWKS.',
        { kid },
      );
    }
    if (!keyMatchesAlgorithm(key, algorithm)) {
      throw new OidcVerificationError(
        'OIDC_KEY_ALGORITHM_MISMATCH',
        'OIDC JWKS key type does not match JWT algorithm.',
        { kid, alg: algorithm, kty: key.kty, crv: key.crv },
      );
    }
    try {
      return createPublicKey({
        key,
        format: 'jwk',
      });
    } catch {
      throw new OidcVerificationError(
        'OIDC_KEY_INVALID',
        'OIDC JWKS public key could not be imported.',
        { kid },
      );
    }
  }

  private async getJwks(forceRefresh: boolean): Promise<CachedJwks> {
    const now = this.now();
    if (
      !forceRefresh &&
      this.jwksCache &&
      this.jwksCache.expiresAt > now
    ) {
      return this.jwksCache;
    }
    if (this.refreshPromise) return await this.refreshPromise;

    this.refreshPromise = this.refreshJwks();
    try {
      const refreshed = await this.refreshPromise;
      this.jwksCache = refreshed;
      return refreshed;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async refreshJwks(): Promise<CachedJwks> {
    const jwksUri = await this.resolveJwksUri();
    const response = await this.fetchJson(
      jwksUri,
      'OIDC JWKS',
    );
    const body = record(response);
    if (!body || !Array.isArray(body.keys)) {
      throw new OidcVerificationError(
        'OIDC_JWKS_INVALID',
        'OIDC JWKS response is invalid.',
      );
    }
    if (body.keys.length < 1 || body.keys.length > 128) {
      throw new OidcVerificationError(
        'OIDC_JWKS_INVALID',
        'OIDC JWKS contains an invalid number of keys.',
      );
    }

    const keys = new Map<string, JsonWebKey>();
    for (const entry of body.keys) {
      const jwk = record(entry);
      if (
        !jwk ||
        typeof jwk.kid !== 'string' ||
        jwk.kid.length < 1 ||
        jwk.kid.length > 256 ||
        typeof jwk.kty !== 'string'
      ) {
        continue;
      }
      if (keys.has(jwk.kid)) {
        throw new OidcVerificationError(
          'OIDC_JWKS_DUPLICATE_KID',
          'OIDC JWKS contains duplicate kid values.',
          { kid: jwk.kid },
        );
      }
      keys.set(jwk.kid, jwk as JsonWebKey);
    }
    if (keys.size === 0) {
      throw new OidcVerificationError(
        'OIDC_JWKS_INVALID',
        'OIDC JWKS contains no usable keyed public keys.',
      );
    }
    return {
      keys,
      expiresAt: this.now() + this.cacheTtlMs,
    };
  }

  private async resolveJwksUri(): Promise<string> {
    if (this.jwksUri) return this.jwksUri;
    const now = this.now();
    if (
      this.discoveryCache &&
      this.discoveryCache.expiresAt > now
    ) {
      return this.discoveryCache.jwksUri;
    }

    const discoveryUrl =
      this.issuer +
      '/.well-known/openid-configuration';
    const response = await this.fetchJson(
      discoveryUrl,
      'OIDC discovery',
    );
    const body = record(response);
    if (
      !body ||
      typeof body.issuer !== 'string' ||
      typeof body.jwks_uri !== 'string'
    ) {
      throw new OidcVerificationError(
        'OIDC_DISCOVERY_INVALID',
        'OIDC discovery response is invalid.',
      );
    }
    if (body.issuer.replace(/\/+$/, '') !== this.issuer) {
      throw new OidcVerificationError(
        'OIDC_DISCOVERY_ISSUER_MISMATCH',
        'OIDC discovery issuer does not match configured issuer.',
      );
    }
    const url = assertTrustedHttpUrl(
      body.jwks_uri,
      'OIDC discovery JWKS URI',
      this.allowInsecureHttp,
    );
    const jwksUri = url.toString();
    this.discoveryCache = {
      jwksUri,
      expiresAt: now + this.cacheTtlMs,
    };
    return jwksUri;
  }

  private async fetchJson(
    url: string,
    label: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchFn(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OidcVerificationError(
          'OIDC_HTTP_ERROR',
          `${label} endpoint returned HTTP ${response.status}.`,
          { status: response.status, url },
        );
      }
      const contentLength = Number(
        response.headers.get('content-length') ?? '0',
      );
      if (
        Number.isFinite(contentLength) &&
        contentLength > 1_048_576
      ) {
        throw new OidcVerificationError(
          'OIDC_RESPONSE_TOO_LARGE',
          `${label} response exceeds the 1 MiB limit.`,
        );
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
        throw new OidcVerificationError(
          'OIDC_RESPONSE_TOO_LARGE',
          `${label} response exceeds the 1 MiB limit.`,
        );
      }
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (
        error instanceof OidcVerificationError
      ) {
        throw error;
      }
      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new OidcVerificationError(
          'OIDC_HTTP_TIMEOUT',
          `${label} request timed out.`,
          { url },
        );
      }
      throw new OidcVerificationError(
        'OIDC_HTTP_FAILED',
        `${label} request failed.`,
        {
          url,
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
