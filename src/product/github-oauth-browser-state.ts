import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { D1DatabaseLike } from './d1-control-plane-store.js';

const MAX_AGE_SECONDS = 10 * 60;
const COOKIE_NAME = '__Host-nwx_github_oauth';
const TOKEN_FORMAT = /^[A-Za-z0-9_-]+$/;
const STATE_MAX_CHARS = 1500;

export interface GitHubOAuthStateConsumeStore {
  /** Persist issuance before redirect; no callback is valid without a row. */
  issue(stateHash: string, expiresAt: number, now: number): Promise<boolean>;
  /** Atomic pending→consumed. Duplicate, revoked, expired => false. */
  consumeOnce(stateHash: string, expiresAt: number, now: number): Promise<boolean>;
  /** Atomic pending→revoked, independent of any OAuth token revocation. */
  revoke(stateHash: string, now: number): Promise<boolean>;
}

/** Memory model is for tests; production requires a shared durable CAS store. */
export class MemoryGitHubOAuthStateConsumeStore implements GitHubOAuthStateConsumeStore {
  private readonly rows = new Map<string, {expiresAt:number; state:'pending'|'consumed'|'revoked'}>();
  async issue(stateHash: string, expiresAt: number, now: number): Promise<boolean> {
    if (expiresAt <= now || this.rows.has(stateHash)) return false;
    this.rows.set(stateHash,{expiresAt,state:'pending'});
    return true;
  }
  async consumeOnce(stateHash: string, expiresAt: number, now: number): Promise<boolean> {
    const row=this.rows.get(stateHash);
    if (!row || row.state !== 'pending' || row.expiresAt !== expiresAt ||
        expiresAt <= now) return false;
    row.state='consumed';
    return true;
  }
  async revoke(stateHash: string, now: number): Promise<boolean> {
    const row=this.rows.get(stateHash);
    if (!row || row.state !== 'pending' || row.expiresAt <= now) return false;
    row.state='revoked';
    return true;
  }
}

/**
 * REVIEWED MIGRATION REQUIRED BEFORE OPT-IN (no Cloudflare/DNS edits here):
 *
 * CREATE TABLE github_oauth_browser_states (
 *   state_hash TEXT PRIMARY KEY NOT NULL,
 *   expires_at INTEGER NOT NULL,
 *   status TEXT NOT NULL CHECK(status IN ('pending','consumed','revoked')),
 *   changed_at INTEGER NOT NULL
 * );
 *
 * SQLite/D1 atomic single-row INSERT and UPDATE ... WHERE status='pending'
 * are the cross-Worker one-time/terminal-revoke barrier.
 */
export class D1GitHubOAuthStateConsumeStore implements GitHubOAuthStateConsumeStore {
  constructor(private readonly db: Pick<D1DatabaseLike, 'prepare'>) {}
  private async changed(sql:string,...params:unknown[]):Promise<boolean> {
    const result=await this.db.prepare(sql).bind(...params).run();
    if (result.success === false || !Number.isInteger(result.meta?.changes) ||
        ![0,1].includes(result.meta!.changes!))
      throw new Error('OAUTH_STATE_STORE_UNAVAILABLE');
    return result.meta!.changes === 1;
  }
  async issue(stateHash: string, expiresAt: number, now: number): Promise<boolean> {
    if (!validDigest(stateHash) || !validTime(expiresAt) ||
        !validTime(now) || expiresAt <= now) return false;
    return this.changed(
      'INSERT INTO github_oauth_browser_states ' +
      '(state_hash,expires_at,status,changed_at) VALUES (?,?,' +
      "'pending'" + ',?) ON CONFLICT(state_hash) DO NOTHING',
      stateHash,expiresAt,now,
    );
  }
  async consumeOnce(stateHash: string, expiresAt: number, now: number): Promise<boolean> {
    if (!validDigest(stateHash) || !validTime(expiresAt) ||
        !validTime(now) || expiresAt <= now) return false;
    return this.changed(
      'UPDATE github_oauth_browser_states SET status=' +
      "'consumed'" + ',changed_at=? WHERE state_hash=? AND expires_at=? ' +
      "AND status='pending' AND expires_at>?",
      now,stateHash,expiresAt,now,
    );
  }
  async revoke(stateHash: string, now: number): Promise<boolean> {
    if (!validDigest(stateHash) || !validTime(now)) return false;
    return this.changed(
      'UPDATE github_oauth_browser_states SET status=' +
      "'revoked'" + ',changed_at=? WHERE state_hash=? ' +
      "AND status='pending' AND expires_at>?",
      now,stateHash,now,
    );
  }
}
function validDigest(value:string):boolean {return /^[a-f0-9]{64}$/.test(value);}
function validTime(value:number):boolean {return Number.isSafeInteger(value) && value>=0;}
export function githubOAuthStateDigest(state:string):string {
  return createHash('sha256').update(state,'utf8').digest('hex');
}

function secretBytes(secret: string): Buffer {
  if (secret.length < 32) throw new Error('OAuth state signing key is invalid.');
  return Buffer.from(secret, 'utf8');
}

function hmac(input: string, secret: string): Buffer {
  return createHmac('sha256', secretBytes(secret)).update(input, 'utf8').digest();
}

function equal(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeNext(next: string | null): string {
  const value = next?.trim() || '/';
  return value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.length <= 512 ? value : '/';
}

interface State {
  v: 2;
  kind: 'github-browser-oauth-state';
  origin: string;
  nonce: string;
  browser: string;
  next: string;
  iat: number;
  exp: number;
}

function originOf(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.origin === 'null') {
    throw new Error('OAUTH_HTTPS_ORIGIN_REQUIRED');
  }
  return parsed.origin;
}

function browserCookie(token: string, maxAge: number): string {
  return [
    COOKIE_NAME + '=' + token,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + String(maxAge),
  ].join('; ');
}

export function clearGitHubOAuthBrowserCookie(): string {
  return browserCookie('', 0);
}

/** Each login has a fresh browser secret; no raw secret appears in state. */
export function beginGitHubOAuthBrowserState(
  requestUrl: string, next: string | null, signingSecret: string,
  now = new Date(),
): { state: string; cookie: string } {
  const origin = originOf(requestUrl);
  const iat = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(iat)) throw new Error('OAUTH_INVALID_CLOCK');
  const nonce = randomBytes(32).toString('base64url');
  const browserSecret = randomBytes(32).toString('base64url');
  const payload: State = {
    v: 2, kind: 'github-browser-oauth-state', origin, nonce,
    browser: hmac('browser:' + origin + ':' + browserSecret, signingSecret).toString('base64url'),
    next: safeNext(next), iat, exp: iat + MAX_AGE_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = hmac('state:' + encoded, signingSecret).toString('base64url');
  return {
    state: encoded + '.' + signature,
    cookie: browserCookie(browserSecret, MAX_AGE_SECONDS),
  };
}

function browserToken(request: Request): string | null {
  const cookies = request.headers.get('cookie') ?? '';
  const found = cookies.split(';').map(x => x.trim()).filter(x =>
    x.startsWith(COOKIE_NAME + '='));
  if (found.length !== 1) return null;
  const token = found[0]!.slice(COOKIE_NAME.length + 1);
  return token.length === 43 && TOKEN_FORMAT.test(token) ? token : null;
}

export async function consumeGitHubOAuthBrowserState(
  request: Request, state: string, signingSecret: string,
  store: GitHubOAuthStateConsumeStore, now = new Date(),
): Promise<{ next: string } | null> {
  if (typeof state !== 'string' || state.length > STATE_MAX_CHARS ||
      state.length < 40) return null;
  const [encoded, signed, extra] = state.split('.');
  if (extra !== undefined || !encoded || !signed ||
      !TOKEN_FORMAT.test(encoded) || !TOKEN_FORMAT.test(signed)) return null;
  let payload: State;
  let nowSeconds: number;
  try {
    const supplied = Buffer.from(signed, 'base64url');
    if (!equal(supplied, hmac('state:' + encoded, signingSecret))) return null;
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as State;
    nowSeconds = Math.floor(now.getTime() / 1000);
    const origin = originOf(request.url);
    if (payload?.v !== 2 || payload.kind !== 'github-browser-oauth-state' ||
        payload.origin !== origin ||
        typeof payload.nonce !== 'string' ||
        payload.nonce.length !== 43 || !TOKEN_FORMAT.test(payload.nonce) ||
        typeof payload.browser !== 'string' ||
        payload.browser.length !== 43 || !TOKEN_FORMAT.test(payload.browser) ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(nowSeconds) ||
        payload.iat > nowSeconds || payload.exp <= nowSeconds ||
        payload.exp - payload.iat !== MAX_AGE_SECONDS ||
        payload.next !== safeNext(payload.next)) return null;
    const browser = browserToken(request);
    if (!browser) return null;
    if (!equal(Buffer.from(payload.browser, 'base64url'),
      hmac('browser:' + origin + ':' + browser, signingSecret))) return null;
  } catch {
    return null; // Invalid signature, browser binding, origin or JSON.
  }

  // Storage exceptions are intentionally OUTSIDE the invalid-user catch:
  // a D1 outage/invalid response is an infrastructure 503, never login 400.
  try {
    if (!await store.consumeOnce(
      githubOAuthStateDigest(state), payload.exp, nowSeconds,
    )) return null;
  } catch {
    throw new Error('OAUTH_STATE_STORE_UNAVAILABLE');
  }
  return {next:payload.next};
}
