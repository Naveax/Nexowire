import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_PLANS } from '../src/product/plans.js';
import { quoteToolUsage } from '../src/product/usage-policy.js';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { enforceHostedMcpMetering } from '../src/mcp/hosted-metering.js';
import type { ControlPlaneMcpClient } from '../src/hub/control-plane-mcp-auth.js';

test('free-only mode enforces 1,000 weighted calls, idempotency and UTC reset', async () => {
  let clock = new Date('2026-10-31T23:59:59.000Z');
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, { freeOnly: true, now: () => clock });
  await service.ensureAccount({ id: 'acct_free' });

  const bulk = await service.chargeUsage({
    accountId: 'acct_free', eventId: 'normal-995',
    toolName: 'machine_health', baseCredits: 995,
  });
  assert.equal(bulk.status, 'charged');
  assert.equal(bulk.remainingCredits, 5);

  const special = await service.chargeUsage({
    accountId: 'acct_free', eventId: 'special-1', toolName: 'skill_read',
  });
  assert.equal(special.status, 'charged');
  assert.equal(special.chargedCredits, 5);
  assert.equal(special.remainingCredits, 0);

  const retry = await service.chargeUsage({
    accountId: 'acct_free', eventId: 'special-1', toolName: 'skill_read',
  });
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.chargedCredits, 0);

  const denied = await service.chargeUsage({
    accountId: 'acct_free', eventId: 'over-limit', toolName: 'machine_health',
  });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'quota-exhausted');
  assert.equal(denied.remainingCredits, 0);

  clock = new Date('2026-11-01T00:00:00.000Z');
  const reset = await service.chargeUsage({
    accountId: 'acct_free', eventId: 'new-month', toolName: 'machine_health',
  });
  assert.equal(reset.status, 'charged');
  assert.equal(reset.remainingCredits, 999);
});

test('special-skill marker weights ordinary tools five times; normal tools stay at 1', () => {
  assert.equal(PRODUCT_PLANS.free.monthlyCredits, 1_000);
  assert.equal(quoteToolUsage(PRODUCT_PLANS.free, 'machine_health').credits, 1);
  assert.equal(quoteToolUsage(PRODUCT_PLANS.free, 'skill_read').credits, 5);
  assert.equal(quoteToolUsage(PRODUCT_PLANS.free, 'skills_list').credits, 5);
  assert.equal(quoteToolUsage(PRODUCT_PLANS.free, 'machine_health', 1, true).credits, 5);
  assert.equal(quoteToolUsage(PRODUCT_PLANS.free, 'machine_health', 3, true).credits, 15);
  assert.equal(quoteToolUsage(PRODUCT_PLANS.free, 'windows_private_desktop_start', 1, true).allowed, false);
});

test('free-only mode neutralizes legacy paid entitlements and disables paid plan changes', async () => {
  const store = new MemoryControlPlaneStore();
  const original = new ControlPlaneService(store);
  const account = await original.ensureAccount({ id: 'legacy_paid', admin: true });
  await store.putAccount({ ...account, planId: 'pro' });
  const service = new ControlPlaneService(store, { freeOnly: true });
  const dashboard = await service.dashboard({ accountId: account.id, role: 'admin' });
  assert.equal(dashboard.planId, 'free');
  assert.equal(dashboard.usage.monthlyCredits, 1_000);
  assert.equal(dashboard.privateControlsIncluded, false);

  const gated = await service.chargeUsage({
    accountId: account.id, eventId: 'legacy-premium',
    toolName: 'windows_private_desktop_start',
  });
  assert.equal(gated.status, 'denied');
  assert.equal(gated.reason, 'feature-not-in-plan');

  await assert.rejects(
    service.configureCustomPrepaidPlan(
      { accountId: account.id, role: 'admin' },
      account.id, {},
    ),
    /BILLING_PAUSED/,
  );
});

test('hosted MCP metering forwards marked skill context before execution', async () => {
  let specialSkill: boolean | undefined;
  const client = {
    chargeTool: async (input: { specialSkill?: boolean }) => {
      specialSkill = input.specialSkill;
      return { status: 'charged', chargedCredits: 5, remainingCredits: 995, reason: null };
    },
  } as unknown as ControlPlaneMcpClient;
  const decision = await enforceHostedMcpMetering({
    authorization: {
      kind: 'control-plane', scope: 'mcp',
      accountId: 'acct_free', role: 'user', allowedDeviceIds: ['device-a'],
    },
    authorizationHeader: 'Bearer nwx_mcp_test',
    body: {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'machine_health',
        arguments: {},
        _meta: { 'nexowire/special-skill': true },
      },
    },
    client,
  });
  assert.deepEqual(decision, { allowed: true });
  assert.equal(specialSkill, true);
});
