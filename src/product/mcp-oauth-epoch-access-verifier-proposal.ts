import { createHash } from 'node:crypto';
import type { D1DatabaseLike } from './d1-control-plane-store.js';

export interface ProposedEpochAccessIdentity {
  accountId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  sessionEpoch: number;
}

type AccessRow = {
  account_id: string;
  client_id: string;
  resource: string;
  scopes_json: string;
  expires_at: string;
  created_at: string;
  session_epoch: number;
  generation: number | null;
  locked: number | null;
  had_logout: string | null;
  had_transition: number;
};

/**
 * STAGING-ONLY access-token verifier. It does not replace or modify the
 * production OAuth service, D1 migration, Worker handler, or MCP executor.
 *
 * One SQL read joins the token row to the current account generation.
 * A token is valid only in the account's present unlocked generation.
 * Old epoch-0 tokens remain valid ONLY before the account has ever entered
 * the epoch lifecycle. No identity caching; call once per request.
 *
 * This is authentication, NOT an execution authorization boundary:
 * mutating tools still need fresh owner/device/scope checks before dispatch.
 */
export class ProposedMcpOAuthEpochAccessVerifier {
  constructor(private readonly deps: {
    db: D1DatabaseLike;
    resource: string; // immutable, first-party configured OAuth resource
    now?: () => Date;
  }) {}

  async authenticateAccessToken(rawToken: string): Promise<ProposedEpochAccessIdentity | null> {
    if (typeof rawToken !== 'string' ||
        !/^nwx_mcp_[A-Za-z0-9_-]{1,500}$/.test(rawToken) ||
        rawToken.length > 512 ||
        typeof this.deps.resource !== 'string' || !this.deps.resource) {
      return null;
    }
    const now = (this.deps.now ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Trusted OAuth verification clock unavailable');
    }

    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
    // JOIN prevents accepting one token epoch against a separately
    // read stale account generation. It does NOT prevent revocation
    // immediately after this query or an already running tool.
    const record = await this.deps.db.prepare(
      'SELECT t.account_id,t.client_id,t.resource,t.scopes_json,t.expires_at,t.created_at,t.session_epoch,e.generation,e.locked,g.account_id AS had_logout, ' +
      'EXISTS(SELECT 1 FROM mcp_oauth_session_epoch_events AS v WHERE v.account_id=t.account_id) AS had_transition ' +
      'FROM mcp_oauth_access_tokens AS t ' +
      'LEFT JOIN mcp_oauth_session_epochs AS e ON e.account_id=t.account_id ' +
      'LEFT JOIN mcp_oauth_account_logout_gate AS g ON g.account_id=t.account_id ' +
      'WHERE t.token_hash=?',
    ).bind(tokenHash).first<AccessRow>();

    if (record === null || record.resource !== this.deps.resource ||
        typeof record.account_id !== 'string' || !record.account_id ||
        typeof record.client_id !== 'string' || !record.client_id ||
        !Number.isSafeInteger(record.session_epoch) || record.session_epoch < 0 ||
        typeof record.expires_at !== 'string' ||
        !Number.isFinite(Date.parse(record.expires_at)) ||
        Date.parse(record.expires_at) <= now.getTime() ||
        typeof record.created_at !== 'string' ||
        !Number.isFinite(Date.parse(record.created_at)) ||
        Date.parse(record.created_at) > now.getTime()) {
      return null;
    }

    if (record.generation === null) {
      // A missing lifecycle row is only legal for an untouched legacy
      // account. A token born in a future generation is not accepted.
      if (record.session_epoch !== 0 || record.locked !== null ||
          record.had_logout !== null || record.had_transition !== 0) return null;
    } else if (!Number.isSafeInteger(record.generation) ||
               record.generation < 0 || record.locked !== 0 ||
               record.generation !== record.session_epoch) {
      return null;
    }

    let scopes: unknown;
    try { scopes = JSON.parse(record.scopes_json); }
    catch { return null; }
    if (!Array.isArray(scopes) ||
        scopes.length < 1 || scopes.length > 32 ||
        !scopes.every(x => typeof x === 'string' && x.length > 0 &&
          x.length <= 128) ||
        !scopes.includes('mcp')) {
      return null;
    }

    return {
      accountId: record.account_id,
      clientId: record.client_id,
      resource: record.resource,
      scopes: [...scopes],
      sessionEpoch: record.session_epoch,
    };
  }
}
