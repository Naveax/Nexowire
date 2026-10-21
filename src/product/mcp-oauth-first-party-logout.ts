import type {
  ProposedMcpOAuthSessionEpoch,
  ProposedOAuthSessionEpochDecision,
} from './mcp-oauth-session-epoch-proposal.js';

/**
 * Trusted first-party logout bridge. This is not a generic MCP Bearer-token
 * revocation endpoint. Requires server-authenticated first-party session proof.
 *
 * The injected epoch store must be the same durable authority consulted by
 * atomic refresh rotation AND MCP access-token verification. Without all three
 * wired together, this remains DRAFT, not production logout acceptance.
 *
 * A single access-token invalidation does not revoke refresh tokens.
 * Call logout() to lock the entire owner's grant generation instead.
 */
export class FirstPartyMcpOAuthLogoutBoundary {
  constructor(private readonly deps: {
    /** A server-side login/session verifier, never an OAuth Bearer identity. */
    verifyFirstPartyOwnerSession(proof:string):Promise<{
      accountId:string;role:'user'|'admin'|'service';
    }|null>;
    epoch:Pick<ProposedMcpOAuthSessionEpoch,'transition'>;
  }) {}

  async logout(input: {
    firstPartySessionProof:string;
    targetAccountId:string;
    operationId:string;
  }):Promise<ProposedOAuthSessionEpochDecision> {
    if (typeof input.firstPartySessionProof !== 'string' ||
        input.firstPartySessionProof.length < 16 ||
        input.firstPartySessionProof.length > 2048 ||
        typeof input.targetAccountId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.targetAccountId) ||
        typeof input.operationId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.operationId))
      return {status:'denied'};
    let identity:Awaited<ReturnType<typeof this.deps.verifyFirstPartyOwnerSession>>;
    try {
      identity=await this.deps.verifyFirstPartyOwnerSession(input.firstPartySessionProof);
    } catch {
      throw new Error('OAUTH_FIRST_PARTY_OWNER_UNAVAILABLE');
    }
    if (!identity || identity.role === 'service' ||
        identity.accountId !== input.targetAccountId)
      return {status:'denied'};
    // The durable CAS transition locks every old refresh/access grant by
    // session generation when the issuer/verifier are correctly epoch wired.
    // This *cannot* be called using an MCP refresh/access Bearer alone.
    return this.deps.epoch.transition({
      authenticatedAccountId:identity.accountId,
      targetAccountId:input.targetAccountId,
      operationId:input.operationId,
      kind:'logout',
    });
  }
}
