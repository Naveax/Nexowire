import type { D1DatabaseLike } from './d1-control-plane-store.js';

export type ProposedOAuthSessionEpochState = Readonly<{
  generation: number;
  locked: boolean;
}>;
export type ProposedOAuthSessionEpochDecision =
  | Readonly<{ status: 'transitioned' | 'duplicate'; state: ProposedOAuthSessionEpochState }>
  | Readonly<{ status: 'denied' }>;

/**
 * DEV/STAGING-only session epoch lifecycle. NOT attached to production
 * OAuth/Worker routes. All authority checks MUST be bound to a freshly
 * verified first-party account session, never MCP parameters.
 *
 * Even an approved transition is NOT permission to execute tools. The real
 * token issuer and the verifier must become epoch-aware before rollout.
 */
export class ProposedMcpOAuthSessionEpoch {
  constructor(private readonly deps: {
    db: D1DatabaseLike;
    verifyCurrentOwner(input: { accountId: string }): Promise<boolean>;
    verifyFreshFirstPartyLogin(input: { accountId: string }): Promise<boolean>;
    now?: () => Date;
  }) {}

  async state(accountId: string): Promise<ProposedOAuthSessionEpochState> {
    if (typeof accountId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(accountId)) {
      throw new Error('Invalid account ID');
    }
    const row = await this.deps.db.prepare(
      'SELECT generation, locked FROM mcp_oauth_session_epochs WHERE account_id = ?',
    ).bind(accountId).first<{generation:number;locked:number}>();
    if (row === null) return { generation: 0, locked: false };
    if (!Number.isSafeInteger(row.generation) || row.generation < 0 ||
        (row.locked !== 0 && row.locked !== 1)) {
      throw new Error('Invalid persisted OAuth session epoch');
    }
    return { generation: row.generation, locked: row.locked === 1 };
  }

  async transition(input: {
    authenticatedAccountId: string;
    targetAccountId: string;
    operationId: string;
    kind: 'logout' | 'reauth';
  }): Promise<ProposedOAuthSessionEpochDecision> {
    const pattern = /^[A-Za-z0-9_.:-]{1,128}$/;
    if (typeof input.authenticatedAccountId !== 'string' ||
        !pattern.test(input.authenticatedAccountId) ||
        typeof input.targetAccountId !== 'string' ||
        !pattern.test(input.targetAccountId) ||
        typeof input.operationId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.operationId) ||
        (input.kind !== 'logout' && input.kind !== 'reauth')) {
      throw new Error('Invalid trusted session epoch input');
    }
    if (input.authenticatedAccountId !== input.targetAccountId) {
      return { status: 'denied' };
    }

    // A stale access token must not establish fresh login. Reauthorization
    // requires an independent, recent first-party identity proof.
    const allowed = input.kind === 'logout'
      ? await this.deps.verifyCurrentOwner({ accountId: input.targetAccountId })
      : await this.deps.verifyFreshFirstPartyLogin({ accountId: input.targetAccountId });
    if (allowed !== true) return { status: 'denied' };

    const findPrior = async () => this.deps.db.prepare(
      'SELECT account_id, kind FROM mcp_oauth_session_epoch_events WHERE operation_id = ?',
    ).bind(input.operationId).first<{ account_id: string; kind: string }>();

    const prior = await findPrior();
    if (prior !== null) {
      if (prior.account_id !== input.targetAccountId || prior.kind !== input.kind) {
        throw new Error('Session epoch operation ID collision');
      }
      return { status: 'duplicate', state: await this.state(input.targetAccountId) };
    }

    const expected = await this.state(input.targetAccountId);
    // A logout is valid only for an active epoch; reauth only for a locked
    // epoch. SQL repeats these conditions atomically to defeat races.
    if ((input.kind === 'logout' && expected.locked) ||
        (input.kind === 'reauth' && !expected.locked)) {
      return { status: 'denied' };
    }
    const clock = (this.deps.now ?? (() => new Date()))();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
      throw new Error('Invalid trusted session epoch clock');
    }
    try {
      const result = await this.deps.db.prepare(
        'INSERT INTO mcp_oauth_session_epoch_events (operation_id,account_id,kind,expected_generation,changed_at) VALUES (?,?,?,?,?)',
      ).bind(input.operationId, input.targetAccountId, input.kind,
        expected.generation, clock.toISOString()).run();
      if (result.success === false ||
          !Number.isSafeInteger(result.meta?.changes) ||
          Number(result.meta?.changes) < 1) {
        throw new Error('Session epoch transition not acknowledged');
      }
      return { status: 'transitioned', state: await this.state(input.targetAccountId) };
    } catch (error) {
      // An ambiguous committed D1 transition must NEVER be retried as a
      // second logout or reauthorization under another ID.
      const committed = await findPrior();
      if (committed !== null) {
        if (committed.account_id !== input.targetAccountId ||
            committed.kind !== input.kind) {
          throw new Error('Session epoch operation ID collision');
        }
        return { status: 'duplicate', state: await this.state(input.targetAccountId) };
      }
      throw error;
    }
  }
}
