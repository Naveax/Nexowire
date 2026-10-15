import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { D1DatabaseLike } from './d1-control-plane-store.js';

const sha256 = (value: string) => createHash('sha256').update(value,'utf8').digest();
const hash = (value: string) => sha256(value).toString('hex');
const nonce = (prefix: string) => prefix + randomBytes(32).toString('base64url');

export type ProposedMcpAtomicCodeResponse = Readonly<{
  access_token: string;
  refresh_token?: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}>;

/**
 * STAGING/DEV ONLY. No Worker imports. Caller MUST have completed the real
 * OAuth client's redirect validation before handing the exact URI here.
 * PKCE is recomputed server-side, code bindings are read from D1, and one
 * SQL INSERT consumes the authorization code AND issues replacement tokens.
 *
 * A missing commit acknowledgment fails closed. Raw token material cannot
 * be recovered from a remote committed write whose reply was lost: users
 * must restart the first-party OAuth authorization flow, not retry code.
 */
export class ProposedMcpOAuthEpochAtomicCode {
  constructor(private readonly deps: {
    db: D1DatabaseLike;
    resource: string; // trusted first-party OAuth resource
    now?: () => Date;
  }) {}

  async exchange(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string; // EXACT already validated OAuth redirect URI
    requestedResource: string;
  }): Promise<ProposedMcpAtomicCodeResponse> {
    if (typeof input.code !== 'string' ||
        !/^nwx_code_[A-Za-z0-9_-]{20,200}$/.test(input.code) ||
        typeof input.codeVerifier !== 'string' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
        typeof input.clientId !== 'string' ||
        input.clientId.length < 1 || input.clientId.length > 512 ||
        typeof input.redirectUri !== 'string' ||
        input.redirectUri.length < 1 || input.redirectUri.length > 2048 ||
        /[\r\n\0]/.test(input.redirectUri) ||
        typeof input.requestedResource !== 'string' ||
        input.requestedResource !== this.deps.resource) {
      throw new Error('Invalid OAuth authorization-code grant');
    }
    const now = (this.deps.now ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Trusted OAuth code exchange clock unavailable');
    }

    const prior = await this.deps.db.prepare(
      'SELECT account_id,client_id,resource,redirect_uri,code_challenge,scopes_json,session_epoch,expires_at,consumed_at ' +
      'FROM mcp_oauth_codes WHERE code_hash=?',
    ).bind(hash(input.code)).first<{
      account_id: string;
      client_id: string;
      resource: string;
      redirect_uri: string;
      code_challenge: string;
      scopes_json: string;
      session_epoch: number;
      expires_at: string;
      consumed_at: string | null;
    }>();
    const challenge = sha256(input.codeVerifier).toString('base64url');
    if (!prior || prior.client_id !== input.clientId ||
        prior.resource !== this.deps.resource ||
        prior.redirect_uri !== input.redirectUri ||
        prior.code_challenge !== challenge ||
        prior.consumed_at !== null ||
        !Number.isSafeInteger(prior.session_epoch) ||
        prior.session_epoch < 0 ||
        !Number.isFinite(Date.parse(prior.expires_at)) ||
        Date.parse(prior.expires_at) <= now.getTime()) {
      throw new Error('OAuth authorization-code credential unavailable');
    }

    let scopes: unknown;
    try { scopes = JSON.parse(prior.scopes_json); }
    catch { throw new Error('Invalid OAuth code scopes'); }
    if (!Array.isArray(scopes) || scopes.length < 1 ||
        !scopes.every(x => typeof x === 'string' &&
          (x === 'mcp' || x === 'offline_access')) ||
        !scopes.includes('mcp')) {
      throw new Error('Invalid OAuth code scopes');
    }

    const current = await this.deps.db.prepare(
      'SELECT generation,locked FROM mcp_oauth_session_epochs WHERE account_id=?',
    ).bind(prior.account_id).first<{generation:number;locked:number}>();
    if (!current || current.locked !== 0 ||
        !Number.isSafeInteger(current.generation) ||
        current.generation !== prior.session_epoch) {
      throw new Error('OAuth code session epoch unavailable');
    }

    const accessToken=nonce('nwx_mcp_');
    const refreshToken=scopes.includes('offline_access')
      ? nonce('nwx_refresh_') : undefined;
    const accessedAt=now.toISOString();
    const accessExpiresAt=new Date(now.getTime()+3600_000).toISOString();
    const refreshExpiresAt=refreshToken
      ? new Date(now.getTime()+30*86400_000).toISOString() : null;

    const result=await this.deps.db.prepare(
      'INSERT INTO mcp_oauth_epoch_code_redemptions ' +
      '(operation_id,code_hash,account_id,client_id,redirect_uri,code_challenge,resource,scopes_json,session_epoch,redeemed_at,new_access_hash,access_expires_at,new_refresh_hash,refresh_expires_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      randomUUID(),hash(input.code),prior.account_id,prior.client_id,
      prior.redirect_uri,challenge,prior.resource,prior.scopes_json,
      prior.session_epoch,accessedAt,hash(accessToken),accessExpiresAt,
      refreshToken ? hash(refreshToken) : null,refreshExpiresAt,
    ).run();

    if (result.success === false || !Number.isSafeInteger(result.meta?.changes) ||
        Number(result.meta?.changes) !== 1) {
      throw new Error('OAuth authorization-code redemption not acknowledged');
    }
    return {
      access_token:accessToken,
      ...(refreshToken ? {refresh_token:refreshToken} : {}),
      token_type:'Bearer',
      expires_in:3600,
      scope:scopes.join(' '),
    };
  }
}
