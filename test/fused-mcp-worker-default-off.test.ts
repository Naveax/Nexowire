import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const worker=readFileSync(new URL('../cloudflare/worker.js',import.meta.url),'utf8');

test('production fused MCP authorize-and-charge path is compile-time disabled',()=>{
  assert.match(worker,/const PRODUCTION_FUSED_MCP_AUTH_CHARGE_ENABLED = false;/);
  assert.match(worker,/PRODUCTION_FUSED_MCP_AUTH_CHARGE_ENABLED\s*&&\s*url\.pathname === '\/api\/v1\/internal\/mcp\/authorize-charge'/);
  assert.doesNotMatch(worker,/PRODUCTION_FUSED_MCP_AUTH_CHARGE_ENABLED\s*=\s*(?:true|Boolean\(|env\.|request\.)/);
  assert.equal(worker.includes('createFusedMcpAuthorizeChargeHandler({'),true);
  // Exact production router still authenticates and charges through legacy gates.
  assert.match(worker,/\/api\/v1\/internal\/mcp\/authenticate/);
  assert.match(worker,/createControlPlaneHttpHandler\(service,/);
  assert.match(worker,/NEXOWIRE_PAID_BILLING_ENABLED !== 'true'/);
});
