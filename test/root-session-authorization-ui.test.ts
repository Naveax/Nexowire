import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const service = readFileSync(new URL('../src/product/control-plane-service.ts',import.meta.url),'utf8');
const worker = readFileSync(new URL('../cloudflare/worker.js',import.meta.url),'utf8');

test('ROOT is session-bound and UI does not infer elevation from lease expiry',()=>{
  assert.match(service,/ROOT_SESSION_BINDING_REQUIRED/);
  assert.match(service,/grantRootSession/);
  assert.match(service,/getRootSessionGrant/);
  assert.match(service,/revokeControlPlaneSession/);
  assert.match(worker,/LOGOUT_REVOCATION_UNCONFIRMED/);
  assert.match(worker,/isControlPlaneSessionRevoked/);
  assert.match(app,/const rootLeaseActive = device\.rootMode\?\.active === true/);
  assert.match(app,/ROOT BEKLEMEDE \(oturum doğrulanmadı\)/);
  assert.doesNotMatch(app,/rootLeaseActive\s*=\s*Boolean\(device\.rootMode\?\.expiresAt/);
});
