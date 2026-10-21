import { createHmac } from 'node:crypto';
import type { D1DatabaseLike } from './d1-control-plane-store.js';
import type { GitHubOAuthStateConsumeStore } from './github-oauth-browser-state.js';

/**
 * Durable key-epoch fence for GitHub *web-login* state, not MCP grants,
 * owner/CORE capabilities or Windows token elevation.
 *
 * Required reviewed D1 migration (NOT installed by this source-only PR):
 *
 * CREATE TABLE github_oauth_issuer_signers (
 *   issuer TEXT PRIMARY KEY NOT NULL,
 *   signing_epoch INTEGER NOT NULL CHECK(signing_epoch > 0),
 *   key_proof TEXT NOT NULL,
 *   changed_at INTEGER NOT NULL
 * );
 *
 * Existing github_oauth_browser_states schema is unchanged.
 * Both tables must be in the same authoritative D1 database. The CAS check
 * is embedded directly in each INSERT/UPDATE, not a racy separate SELECT.
 */
export class D1IssuerFencedGitHubOAuthStateStore implements GitHubOAuthStateConsumeStore {
  private readonly keyProof: string;
  constructor(
    private readonly db: Pick<D1DatabaseLike, 'prepare'>,
    private readonly issuer: string,
    private readonly signingEpoch: number,
    signingKey: string,
  ) {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || url.origin !== issuer ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !Number.isSafeInteger(signingEpoch) || signingEpoch < 1 || signingEpoch > 2_147_483_647 ||
        signingKey.length < 32) {
      throw new Error('OAUTH_ISSUER_EPOCH_CONFIG_INVALID');
    }
    // HMAC domain separation avoids storing the signing secret itself.
    this.keyProof = createHmac('sha256', signingKey)
      .update('nexowire-github-login-signer-epoch-v1', 'utf8')
      .digest('hex');
  }

  private async changed(sql: string, ...args: unknown[]): Promise<boolean> {
    try {
      const result = await this.db.prepare(sql).bind(...args).run();
      if (result.success === false || !Number.isInteger(result.meta?.changes) ||
          ![0, 1].includes(result.meta!.changes!))
        throw new Error('OAUTH_ISSUER_FENCE_UNAVAILABLE');
      return result.meta!.changes === 1;
    } catch {
      throw new Error('OAUTH_ISSUER_FENCE_UNAVAILABLE');
    }
  }

  private async observeKey(now: number): Promise<void> {
    // Higher configured issuer epoch advances monotonically; old instances
    // must not roll it back, even if an old signing secret is restored.
    await this.changed(
      'INSERT INTO github_oauth_issuer_signers ' +
      '(issuer,signing_epoch,key_proof,changed_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(issuer) DO UPDATE SET ' +
      'signing_epoch=excluded.signing_epoch,key_proof=excluded.key_proof,' +
      'changed_at=excluded.changed_at ' +
      'WHERE excluded.signing_epoch>github_oauth_issuer_signers.signing_epoch',
      this.issuer, this.signingEpoch, this.keyProof, now,
    );
  }

  private currentProofSql(): string {
    return 'EXISTS(SELECT 1 FROM github_oauth_issuer_signers ' +
      'WHERE issuer=? AND signing_epoch=? AND key_proof=?)';
  }

  private valid(stateHash:string, expiresAt:number, now:number):boolean {
    return /^[a-f0-9]{64}$/.test(stateHash) &&
      Number.isSafeInteger(expiresAt) && Number.isSafeInteger(now) &&
      now >= 0 && expiresAt > now;
  }

  async issue(stateHash:string, expiresAt:number, now:number):Promise<boolean> {
    if (!this.valid(stateHash, expiresAt, now)) return false;
    await this.observeKey(now);
    return this.changed(
      'INSERT INTO github_oauth_browser_states ' +
      '(state_hash,expires_at,status,changed_at) ' +
      "SELECT ?,?,'pending',? WHERE " + this.currentProofSql() +
      ' ON CONFLICT(state_hash) DO NOTHING',
      stateHash, expiresAt, now, this.issuer, this.signingEpoch, this.keyProof,
    );
  }

  async consumeOnce(stateHash:string, expiresAt:number, now:number):Promise<boolean> {
    if (!this.valid(stateHash, expiresAt, now)) return false;
    await this.observeKey(now);
    return this.changed(
      "UPDATE github_oauth_browser_states SET status='consumed',changed_at=? " +
      "WHERE state_hash=? AND expires_at=? AND status='pending' " +
      'AND expires_at>? AND ' + this.currentProofSql(),
      now, stateHash, expiresAt, now,
      this.issuer, this.signingEpoch, this.keyProof,
    );
  }

  async revoke(stateHash:string, now:number):Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(stateHash) || !Number.isSafeInteger(now) || now < 0)
      return false;
    // Revocation MUST work for old epochs too. No signer read required:
    // a signed old-state callback still cannot bypass currentProofSql().
    return this.changed(
      "UPDATE github_oauth_browser_states SET status='revoked',changed_at=? " +
      "WHERE state_hash=? AND status='pending' AND expires_at>?",
      now,stateHash,now,
    );
  }
}
