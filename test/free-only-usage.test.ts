import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_PLANS } from '../src/product/plans.js';
import { quoteToolUsage } from '../src/product/usage-policy.js';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { enforceHostedMcpMetering } from '../src/mcp/hosted-metering.js';
import type { ControlPlaneMcpClient } from '../src/hub/control-plane-mcp-auth.js';

test('verified GitHub owner has unlimited Free tool credits without unlocking paid features', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {
    freeOnly: true,
    ownerGithubId: '79841922',
    now: () => new Date('2026-10-07T01:20:00.000Z'),
  });
  const { account: owner } = await service.loginExternalIdentity({
    provider: 'github', subject: '79841922', displayName: 'Naveax',
  });
  const impersonator = await service.ensureAccount({
    id: 'another-admin', displayName: 'Naveax', admin: true,
  });

  const ownerDashboard = await service.dashboard({ accountId: owner.id, role: 'user' });
  assert.equal(ownerDashboard.planId, 'free');
  assert.equal(ownerDashboard.billingMode, 'free');
  assert.equal(ownerDashboard.usage.monthlyCredits, null);
  assert.equal(ownerDashboard.privateControlsIncluded, false);

  const first = await service.chargeUsage({
    accountId: owner.id, eventId: 'owner-over-thousand', toolName: 'machine_health',
    baseCredits: 2_000,
  });
  assert.equal(first.status, 'charged');
  assert.equal(first.remainingCredits, null);
  assert.equal(first.chargedCredits, 2_000);

  const skill = await service.chargeUsage({
    accountId: owner.id, eventId: 'owner-skill', toolName: 'skills_list',
  });
  assert.equal(skill.status, 'charged');
  assert.equal(skill.chargedCredits, 5);
  assert.equal(skill.remainingCredits, null);

  const replay = await service.chargeUsage({
    accountId: owner.id, eventId: 'owner-skill', toolName: 'skills_list',
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.chargedCredits, 0);

  const denied = await service.chargeUsage({
    accountId: owner.id, eventId: 'owner-premium', toolName: 'windows_private_desktop_start',
  });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'feature-not-in-plan');

  const otherDashboard = await service.dashboard({ accountId: impersonator.id, role: 'admin' });
  assert.equal(otherDashboard.usage.monthlyCredits, 1_000);
  const other = await service.chargeUsage({
    accountId: impersonator.id, eventId: 'normal-over-limit', toolName: 'machine_health',
    baseCredits: 1_001,
  });
  assert.equal(other.status, 'denied');
  assert.equal(other.reason, 'quota-exhausted');
  const unconfigured = new ControlPlaneService(store, { freeOnly: true });
  const safeDefault = await unconfigured.dashboard({ accountId: owner.id, role: 'admin' });
  assert.equal(safeDefault.usage.monthlyCredits, 1_000);
});

test('operator-pinned solkaun GitHub ID gets unlimited hosted credits but no special permissions', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {
    freeOnly: true,
    ownerGithubId: '79841922',
    unmeteredGithubIds: ['55827920', 'solkaun', '0', '55827920'],
  });
  const { account: solkaun } = await service.loginExternalIdentity({
    provider: 'github', subject: '55827920', displayName: 'solkaun',
  });
  const dashboard = await service.dashboard({ accountId: solkaun.id, role: 'user' });
  assert.equal(dashboard.planId, 'free');
  assert.equal(dashboard.usage.monthlyCredits, null);
  assert.equal(dashboard.privateControlsIncluded, false);

  const charged = await service.chargeUsage({
    accountId: solkaun.id, eventId: 'solkaun-big',
    toolName: 'machine_health', baseCredits: 1_001,
  });
  assert.equal(charged.status, 'charged');
  assert.equal(charged.remainingCredits, null);
  const repeated = await service.chargeUsage({
    accountId: solkaun.id, eventId: 'solkaun-big',
    toolName: 'machine_health', baseCredits: 1_001,
  });
  assert.equal(repeated.status, 'duplicate');
  assert.equal(repeated.chargedCredits, 0);
  const deniedPremium = await service.chargeUsage({
    accountId: solkaun.id, eventId: 'solkaun-premium',
    toolName: 'windows_private_desktop_start',
  });
  assert.equal(deniedPremium.status, 'denied');
  assert.equal(deniedPremium.reason, 'feature-not-in-plan');

  // A display-name impostor with admin role is still a normal Free user.
  const impostor = await service.ensureAccount({
    id: 'fake-solkaun', displayName: 'solkaun', admin: true,
  });
  const impostorDashboard = await service.dashboard({
    accountId: impostor.id, role: 'admin',
  });
  assert.equal(impostorDashboard.usage.monthlyCredits, 1_000);
  const impostorCharge = await service.chargeUsage({
    accountId: impostor.id, eventId: 'fake-solkaun-over-limit',
    toolName: 'machine_health', baseCredits: 1_001,
  });
  assert.equal(impostorCharge.status, 'denied');
  assert.equal(impostorCharge.reason, 'quota-exhausted');

  // An identical numeric subject from a non-GitHub provider never qualifies.
  const { account: wrongProvider } = await service.loginExternalIdentity({
    provider: 'google', subject: '55827920', displayName: 'solkaun',
  });
  const nonGithubDashboard = await service.dashboard({
    accountId: wrongProvider.id, role: 'user',
  });
  assert.equal(nonGithubDashboard.usage.monthlyCredits, 1_000);

  // Without the operator's pinned ID, Free usage remains bounded.
  const noGrant = new ControlPlaneService(store, {
    freeOnly: true, ownerGithubId: '79841922',
  });
  const noGrantDashboard = await noGrant.dashboard({
    accountId: solkaun.id, role: 'user',
  });
  assert.equal(noGrantDashboard.usage.monthlyCredits, 1_000);
});

test('SinsiVinci verified GitHub ID has unmetered hosted MCP credits only', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {
    freeOnly: true,
    ownerGithubId: '79841922',
    unmeteredGithubIds: ['55827920', '331287442'],
  });
  const { account: friend } = await service.loginExternalIdentity({
    provider: 'github', subject: '331287442', displayName: 'SinsiVinci',
  });
  const dashboard = await service.dashboard({ accountId: friend.id, role: 'user' });
  assert.equal(dashboard.planId, 'free');
  assert.equal(dashboard.billingMode, 'free');
  assert.equal(dashboard.usage.monthlyCredits, null);
  assert.equal(dashboard.privateControlsIncluded, false);

  const charged = await service.chargeUsage({
    accountId: friend.id, eventId: 'sinsivinci-over-monthly-cap',
    toolName: 'machine_health', baseCredits: 1_001,
  });
  assert.equal(charged.status, 'charged');
  assert.equal(charged.chargedCredits, 1_001);
  assert.equal(charged.remainingCredits, null);

  const retry = await service.chargeUsage({
    accountId: friend.id, eventId: 'sinsivinci-over-monthly-cap',
    toolName: 'machine_health', baseCredits: 1_001,
  });
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.chargedCredits, 0);

  const premium = await service.chargeUsage({
    accountId: friend.id, eventId: 'sinsivinci-no-premium',
    toolName: 'windows_private_desktop_start',
  });
  assert.equal(premium.status, 'denied');
  assert.equal(premium.reason, 'feature-not-in-plan');

  const impersonator = await service.ensureAccount({
    id: 'not-sinsivinci', displayName: 'SinsiVinci', admin: true,
  });
  const impersonatorDashboard = await service.dashboard({
    accountId: impersonator.id, role: 'admin',
  });
  assert.equal(impersonatorDashboard.usage.monthlyCredits, 1_000);

  const { account: wrongProvider } = await service.loginExternalIdentity({
    provider: 'google', subject: '331287442', displayName: 'SinsiVinci',
  });
  const wrongProviderDashboard = await service.dashboard({
    accountId: wrongProvider.id, role: 'user',
  });
  assert.equal(wrongProviderDashboard.usage.monthlyCredits, 1_000);

  const { account: wrongGithubId } = await service.loginExternalIdentity({
    provider: 'github', subject: '331287443', displayName: 'SinsiVinci',
  });
  const wrongGithubDashboard = await service.dashboard({
    accountId: wrongGithubId.id, role: 'user',
  });
  assert.equal(wrongGithubDashboard.usage.monthlyCredits, 1_000);

  const noGrant = new ControlPlaneService(store, {
    freeOnly: true, ownerGithubId: '79841922',
  });
  const disabledDashboard = await noGrant.dashboard({
    accountId: friend.id, role: 'user',
  });
  assert.equal(disabledDashboard.usage.monthlyCredits, 1_000);
});

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
