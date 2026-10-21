import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { MemoryMcpOAuthStore } from '../src/product/memory-mcp-oauth-store.js';
import { McpOAuthError, McpOAuthService } from '../src/product/mcp-oauth.js';
import {
  issueOAuthState, issueSessionToken, verifyOAuthState, verifySessionToken,
} from '../src/product/control-plane-session.js';
import { explainDeviceAuthorization, type DeviceAuthorizationFacts } from '../src/security/authorization-explain.js';
import { privilegeRequirement } from '../src/security/privilege.js';

// Synthetic in-process only: no live tokens, filesystem privileges, native
// Broker commands, Windows UAC, Cloudflare or device connections.
const NOW = new Date('2026-10-21T12:00:00.000Z');
const SESSION_SECRET = 'synthetic-owner-session-secret-0123456789abc';
const OTHER_SECRET = 'synthetic-other-session-secret-0123456789abc';
const RESOURCE = 'https://mcp.fixture.invalid/mcp';
const ISSUER = 'https://issuer.fixture.invalid';
const VERIFIER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');

function facts(owner: string, overrides: Partial<DeviceAuthorizationFacts> = {}): DeviceAuthorizationFacts {
  return {
    deviceId:'device-fixture', ownerAccountId:owner, requesterAccountId:owner,
    requesterRole:'user', accessMode:'full', online:true,
    privilegeMode:'broker', adminBridgeReady:true,
    rootLease:{ownerAccountId:owner,expiresAt:new Date(NOW.getTime() + 900_000).toISOString()},
    corePreference:{ownerAccountId:owner,enabled:true,updatedAt:NOW.toISOString()},
    bridgePreference:{ownerAccountId:owner,desiredMode:'on',updatedAt:NOW.toISOString()},
    now:NOW, ...overrides,
  };
}

test('#07 forged session role, wrong owner and service identity cannot elevate Windows', () => {
  const token = issueSessionToken({accountId:'owner-1',role:'user'},SESSION_SECRET,{now:NOW,ttlSeconds:900});
  assert.deepEqual(verifySessionToken(token,SESSION_SECRET,NOW),{
    accountId:'owner-1',role:'user',
  });
  const [payload,signature] = token.split('.');
  assert.ok(payload && signature);
  const forged = JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as Record<string,unknown>;
  forged.role = 'admin';
  const forgedToken = Buffer.from(JSON.stringify(forged),'utf8').toString('base64url') + '.' + signature;
  assert.equal(verifySessionToken(forgedToken,SESSION_SECRET,NOW),null);
  assert.equal(verifySessionToken(token,OTHER_SECRET,NOW),null);
  assert.equal(verifySessionToken(token,SESSION_SECRET,new Date(NOW.getTime()+900_000)),null);

  const owner = verifySessionToken(token,SESSION_SECRET,NOW);
  assert.ok(owner);
  const own = explainDeviceAuthorization(facts(owner.accountId,{
    requesterAccountId:owner.accountId,requesterRole:'user',
  }),'windows.service.control');
  assert.equal(privilegeRequirement('windows.service.control', undefined),'elevated');
  assert.equal(own.root.policyActive,false);
  assert.equal(own.root.sessionBound,false);
  assert.equal(own.core.enabled,true);
  assert.equal(own.core.state,'PAUSED_UNVERIFIED');
  assert.equal(own.operation.elevatedExecutionProven,false);
  assert.equal(own.windows.adminToken,'unverified');
  assert.equal(own.adminBridge.preferenceApplied,false);

  const purportedAdmin = issueSessionToken({accountId:'other-owner',role:'admin'},SESSION_SECRET,{now:NOW});
  const identity = verifySessionToken(purportedAdmin,SESSION_SECRET,NOW);
  assert.ok(identity);
  const foreign = explainDeviceAuthorization(facts('owner-1',{
    requesterAccountId:identity.accountId, requesterRole:'admin',
  }),'windows.service.control');
  assert.equal(foreign.operation.decision,'denied');
  assert.ok(foreign.operation.reasons.includes('DEVICE_OWNER_MISMATCH'));
  const service = explainDeviceAuthorization(facts('owner-1',{
    requesterRole:'service', requesterAccountId:'owner-1',
  }),'windows.service.control');
  assert.equal(service.operation.decision,'denied');
  assert.ok(service.operation.reasons.includes('OWNER_IDENTITY_REQUIRED'));
  assert.equal(service.operation.elevatedExecutionProven,false);
});

test('#07 ROOT lease expires at exactly 15 minutes; CORE remains persisted but never implies UAC approval', () => {
  const justBefore = explainDeviceAuthorization(facts('owner-1',{
    now:new Date(NOW.getTime()+899_999),
  }),'windows.registry.set',{hive:'HKLM'});
  assert.equal(justBefore.root.leaseUnexpired,true);
  assert.equal(justBefore.root.policyActive,false);
  assert.equal(justBefore.operation.elevatedExecutionProven,false);
  const deadline = explainDeviceAuthorization(facts('owner-1',{
    now:new Date(NOW.getTime()+900_000),
  }),'windows.registry.set',{hive:'HKLM'});
  assert.equal(deadline.root.leaseUnexpired,false);
  assert.equal(deadline.root.expiresAt,null);
  assert.equal(deadline.core.duration,'indefinite-revocable');
  assert.equal(deadline.core.enabled,true);
  assert.equal(deadline.core.state,'PAUSED_UNVERIFIED');
  assert.equal(deadline.windows.uacApproval,'unverified');
  assert.equal(deadline.operation.elevatedExecutionProven,false);
  for(const change of [
    {adminBridgeReady:false},
    {online:false},
    {accessMode:'safe' as const},
  ]) {
    const result = explainDeviceAuthorization(facts('owner-1',change),'windows.service.control');
    assert.equal(result.operation.elevatedExecutionProven,false);
    assert.notEqual(result.core.state,'ACTIVE');
  }
});

test('#07 signed CSRF state rejects forged/cross-purpose/expired values; replay/binding is still an acceptance gap', () => {
  const state = issueOAuthState('github','/devices',SESSION_SECRET,{
    now:NOW,ttlSeconds:120,
  });
  assert.deepEqual(verifyOAuthState(state,'github',SESSION_SECRET,new Date(NOW.getTime()+1000)),{next:'/devices'});
  assert.equal(verifyOAuthState(state,'github-app-manifest',SESSION_SECRET,NOW),null);
  assert.equal(verifyOAuthState(state,'github',OTHER_SECRET,NOW),null);
  assert.equal(verifyOAuthState(state+'x','github',SESSION_SECRET,NOW),null);
  assert.equal(verifyOAuthState(state,'github',SESSION_SECRET,new Date(NOW.getTime()+120_000)),null);
  const purposeConfusion = issueSessionToken({accountId:'owner-1',role:'user'},SESSION_SECRET,{now:NOW});
  assert.equal(verifyOAuthState(purposeConfusion,'github',SESSION_SECRET,NOW),null);
  assert.equal(verifySessionToken(state,SESSION_SECRET,NOW),null);
  // EXPECTED CURRENT LIMITATION: state is stateless and is not consumed or
  // browser-session bound here. This assertion documents the missing
  // CSRF replay/nonce trust gate; do not describe it as CSRF acceptance.
  assert.deepEqual(verifyOAuthState(state,'github',SESSION_SECRET,new Date(NOW.getTime()+1000)),{next:'/devices'});
});

test('#07 stale pairing token and old device credential cannot revive ROOT/CORE after re-pair', async () => {
  let clock = NOW;
  const service = new ControlPlaneService(new MemoryControlPlaneStore(),{
    now:()=>clock,
  });
  const owner = {accountId:'owner-1',role:'user'} as const;
  const outsider = {accountId:'owner-2',role:'user'} as const;
  await service.ensureAccount({id:owner.accountId});
  await service.ensureAccount({id:outsider.accountId});
  const first = await service.beginPairing(owner,'owner-pc');
  const paired = await service.consumePairing({
    pairingId:first.pairingId,token:first.token,
    platform:'win32',deviceAnchorHash:'a'.repeat(64),
  });
  const id = paired.device.id;
  await service.setDeviceAccessMode(owner,id,'full');
  await service.setDevicePresence(id,true,clock.toISOString(),{
    privilegeMode:'broker',adminBridgeReady:true,
  });
  const root = await service.setDeviceRootMode(owner,id,true);
  assert.equal(root.rootMode.expiresAt,new Date(NOW.getTime()+900_000).toISOString());
  assert.equal(root.rootMode.active,false);
  const core = await service.setDeviceCorePreference(owner,id,true);
  assert.equal(core.persistentMaintenance.enabled,true);
  assert.equal(core.persistentMaintenance.active,false);
  await assert.rejects(service.setDeviceCorePreference(outsider,id,true),/DEVICE_NOT_FOUND/);

  // A physically re-enrolled fixture keeps its owner and anchor but rotates
  // the credential and clears maintenance grants, instead of inheriting
  // the old browser preference/ROOT lease.
  clock = new Date(NOW.getTime()+30_000);
  const second = await service.beginPairing(owner,'owner-pc-repaired',id);
  const repaired = await service.consumePairing({
    pairingId:second.pairingId,token:second.token,
    platform:'win32',deviceAnchorHash:'a'.repeat(64),
  });
  assert.equal(repaired.device.id,id);
  assert.notEqual(repaired.deviceCredential,paired.deviceCredential);
  assert.equal(await service.authenticateDeviceCredential(paired.deviceCredential),null);
  assert.ok(await service.authenticateDeviceCredential(repaired.deviceCredential));
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.enabled,false);
  assert.equal((await service.dashboard(owner)).devices[0]?.persistentMaintenance.active,false);
  assert.equal((await service.dashboard(owner)).devices[0]?.rootMode.active,false);
  assert.equal((await service.dashboard(owner)).devices[0]?.rootMode.expiresAt,null);
  await assert.rejects(service.consumePairing({
    pairingId:first.pairingId,token:first.token,
    platform:'win32',deviceAnchorHash:'a'.repeat(64),
  }),/PAIRING_ALREADY-CONSUMED/);
  await assert.rejects(service.consumePairing({
    pairingId:second.pairingId,token:second.token,
    platform:'win32',deviceAnchorHash:'a'.repeat(64),
  }),/PAIRING_ALREADY-CONSUMED/);
  await assert.rejects(service.setDeviceRootMode(owner,id,true),/ROOT_REQUIRES_FULL_ONLINE_DEVICE/);
  await assert.rejects(service.setDeviceCorePreference(owner,id,true),/CORE_REQUIRES_FULL_ONLINE_BROKER/);
});

test('#07 public OAuth clients cannot use each other refresh grants; access revoke is not CORE/revoke-all proof', async () => {
  const oauth = new McpOAuthService(new MemoryMcpOAuthStore(),{
    issuer:ISSUER,resource:RESOURCE,now:()=>NOW,
  });
  const register=async (redirect:string)=>
    await oauth.registerClient({redirect_uris:[redirect],token_endpoint_auth_method:'none'}) as {client_id:string};
  const chat = await register('https://chatgpt.com/oauth/callback/fixture');
  const codex = await register('http://127.0.0.1:39444/callback/fixture');
  assert.notEqual(chat.client_id,codex.client_id);
  const issue=async (clientId:string,redirect:string,accountId:string)=>{
    const response = new URL(await oauth.authorize(accountId,new URLSearchParams({
      response_type:'code',client_id:clientId,redirect_uri:redirect,
      code_challenge:CHALLENGE,code_challenge_method:'S256',
      resource:RESOURCE,scope:'mcp offline_access',state:'untrusted-client-state',
    })));
    return oauth.token(new URLSearchParams({
      grant_type:'authorization_code',code:response.searchParams.get('code')!,
      client_id:clientId,redirect_uri:redirect,
      code_verifier:VERIFIER,resource:RESOURCE,
    }));
  };
  const chatIssued=await issue(chat.client_id,'https://chatgpt.com/oauth/callback/fixture','owner-1');
  const codexIssued=await issue(codex.client_id,'http://127.0.0.1:39444/callback/fixture','owner-2');
  const access=await oauth.authenticateAccessToken(chatIssued.access_token);
  assert.equal(access?.accountId,'owner-1');
  assert.deepEqual(access?.scopes,['mcp','offline_access']);
  await assert.rejects(oauth.token(new URLSearchParams({
    grant_type:'refresh_token',refresh_token:chatIssued.refresh_token!,
    client_id:codex.client_id,resource:RESOURCE,
  })),(err:unknown)=>err instanceof McpOAuthError&&err.code==='invalid_grant');
  assert.equal(await oauth.invalidateAccessToken(chatIssued.access_token,'owner-2'),false);
  assert.equal(await oauth.invalidateAccessToken(chatIssued.access_token,'owner-1'),true);
  assert.equal(await oauth.authenticateAccessToken(chatIssued.access_token),null);
  assert.equal((await oauth.authenticateAccessToken(codexIssued.access_token))?.accountId,'owner-2');
  // Access-only revocation does not revoke the refresh grant. Logout/epoch
  // proposals must be independently wired and checked against owner state.
  const refreshed=await oauth.token(new URLSearchParams({
    grant_type:'refresh_token',refresh_token:chatIssued.refresh_token!,
    client_id:chat.client_id,resource:RESOURCE,
  }));
  assert.equal((await oauth.authenticateAccessToken(refreshed.access_token))?.accountId,'owner-1');
  const policy=explainDeviceAuthorization(facts('owner-1'),'windows.service.control');
  assert.equal(policy.operation.elevatedExecutionProven,false);
  assert.equal(policy.core.state,'PAUSED_UNVERIFIED');
  assert.ok(codexIssued.refresh_token);
});