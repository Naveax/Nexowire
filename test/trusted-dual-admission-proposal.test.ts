import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedMcpUsageEventId } from '../src/mcp/hosted-metering.js';
import type { DailyEntitlementResolution } from '../src/product/daily-entitlement-proposal.js';
import type { TrustedDualQuotaRequest, DualQuotaResult } from '../src/product/dual-quota-d1-proposal.js';
import { ProposedTrustedDualAdmission } from '../src/product/trusted-dual-admission-proposal.js';

const stamp = new Date('2026-10-15T23:59:59.900Z');
const validFree = {
  status: 'allowed', tier: 'free',
  quotaSubjectId: 'trusted-subject-001', dailyRequestLimit: 1000,
} as const;
function harness(options: {
  authorize?: () => Promise<boolean>;
  resolve?: () => Promise<DailyEntitlementResolution>;
  reserve?: (request: TrustedDualQuotaRequest) => Promise<DualQuotaResult>;
  now?: () => Date;
} = {}) {
  const seen: TrustedDualQuotaRequest[] = [];
  let authCalls = 0;
  let resolveCalls = 0;
  const subject = new ProposedTrustedDualAdmission({
    authorizeCurrentScopeAndOwnership: async () => {
      authCalls++;
      return options.authorize ? options.authorize() : true;
    },
    entitlement: {
      resolve: async () => {
        resolveCalls++;
        return options.resolve ? options.resolve() : validFree;
      },
    },
    ledger: {
      reserve: async (request) => {
        seen.push(request);
        return options.reserve ? options.reserve(request) : {
          status: 'reserved', dayUtc: '2026-10-15', monthUtc: '2026-10',
          usedDaily: 1, usedMonthlyCredits: request.toolCredits,
        };
      },
    },
    now: options.now ?? (() => stamp),
  });
  const input = {
    authenticatedAccountId: 'owner-account-001',
    invocationId: 'stable-call-001',
    toolName: 'shell_exec',
  };
  return { subject, input, seen, get authCalls() { return authCalls; },
    get resolveCalls() { return resolveCalls; } };
}

test('trusted account yields exactly one combined server-quoted reservation', async () => {
  const h = harness();
  const result = await h.subject.reserveAuthenticated(h.input);
  assert.equal(result.status, 'reserved');
  assert.equal(h.authCalls, 1);
  assert.equal(h.resolveCalls, 1);
  assert.equal(h.seen.length, 1);
  assert.deepEqual(h.seen[0], {
    quotaSubjectId: validFree.quotaSubjectId,
    invocationId: hostedMcpUsageEventId({
      accountId: h.input.authenticatedAccountId, invocationId: h.input.invocationId,
    }),
    acceptedAt: stamp,
    dailyLimit: 1000,
    monthlyCredits: 1000,
    toolCredits: 1,
    billingMode: 'free',
  });
  if (result.status === 'reserved') {
    assert.equal(result.chargedCredits, 1);
    assert.equal(result.dailyLimit, 1000);
  }
});

test('special skill cost is canonical 5x and still only one atomic insert', async () => {
  const h = harness();
  const result = await h.subject.reserveAuthenticated({...h.input,toolName:'skill_read'});
  assert.equal(result.status, 'reserved');
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]!.toolCredits, 5);
});

test('fresh scope/ownership rejection happens BEFORE ledger or entitlement access', async () => {
  const h = harness({ authorize: async () => false });
  assert.deepEqual(await h.subject.reserveAuthenticated(h.input), {
    status: 'denied',reason:'unauthorized',
  });
  assert.equal(h.resolveCalls, 0);
  assert.equal(h.seen.length, 0);
});

test('scope provider outage fails closed with no ledger invocation', async () => {
  const h = harness({ authorize: async () => { throw new Error('OAUTH_UNAVAILABLE'); } });
  await assert.rejects(h.subject.reserveAuthenticated(h.input),/OAUTH_UNAVAILABLE/);
  assert.equal(h.seen.length, 0);
});

test('denied entitlement and paid plan disabled never reach the ledger', async () => {
  const h = harness({resolve:async()=>({
    status:'denied',reason:'paid-plans-disabled',
  })});
  assert.deepEqual(await h.subject.reserveAuthenticated(h.input),{
    status:'denied',reason:'entitlement-denied',
  });
  assert.equal(h.seen.length,0);
});

test('client-shaped quota/tier/owner keys do not override trusted quota quote', async () => {
  const h = harness();
  const request = {...h.input,tier:'pro', quotaSubjectId:'attacker-subject',
    monthlyCredits:999999999,toolCredits:0,dailyLimit:999999999};
  await h.subject.reserveAuthenticated(request);
  assert.equal(h.seen[0]!.quotaSubjectId, validFree.quotaSubjectId);
  assert.equal(h.seen[0]!.dailyLimit,1000);
  assert.equal(h.seen[0]!.monthlyCredits,1000);
  assert.equal(h.seen[0]!.toolCredits,1);
});

test('feature forbidden on Free is denied before touching the dual ledger', async () => {
  const h = harness();
  const result = await h.subject.reserveAuthenticated({...h.input,toolName:'windows_private_screen_capture'});
  assert.deepEqual(result,{status:'denied',reason:'feature-not-in-plan'});
  assert.equal(h.seen.length,0);
});

test('duplicate, daily and monthly refusals never report a new charge', async () => {
  for (const status of ['duplicate','daily-exhausted','monthly-exhausted'] as const) {
    const h = harness({reserve:async()=>({
      status,dayUtc:'2026-10-15',monthUtc:'2026-10',
      usedDaily:1000,usedMonthlyCredits:1000,
    })});
    const result=await h.subject.reserveAuthenticated(h.input);
    assert.equal(result.status,status);
    assert.equal(h.seen.length,1);
    if ('chargedCredits' in result) assert.equal(result.chargedCredits,0);
  }
});

test('unknown D1 error is propagated: no secondary monthly-only charge or retry', async () => {
  const h = harness({reserve:async()=>{throw new Error('D1_COMMIT_UNKNOWN')}});
  await assert.rejects(h.subject.reserveAuthenticated(h.input),/D1_COMMIT_UNKNOWN/);
  assert.equal(h.seen.length,1);
});

test('stable account-based event ID is unchanged across UTC rollover', async () => {
  const a = harness({now:()=>new Date('2026-10-31T23:59:59Z')});
  const b = harness({now:()=>new Date('2026-11-01T00:00:00Z')});
  await a.subject.reserveAuthenticated(a.input);
  await b.subject.reserveAuthenticated(b.input);
  assert.equal(a.seen[0]!.invocationId,b.seen[0]!.invocationId);
  assert.notEqual(a.seen[0]!.acceptedAt.toISOString(),b.seen[0]!.acceptedAt.toISOString());
});

test('clock and input validation abort before reservation', async () => {
  const h = harness({now:()=>new Date('invalid')});
  await assert.rejects(h.subject.reserveAuthenticated(h.input),/clock unavailable/);
  assert.equal(h.seen.length,0);
  await assert.rejects(h.subject.reserveAuthenticated({...h.input,invocationId:'bad'}),/Invalid invocation ID/);
  assert.equal(h.seen.length,0);
});
