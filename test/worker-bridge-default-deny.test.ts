import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const worker=readFileSync(new URL('../cloudflare/worker.js',import.meta.url),'utf8');
const api=readFileSync(new URL('../src/product/control-plane-http.ts',import.meta.url),'utf8');

test('production Worker hardcodes closed Guardian command transport',()=>{
  assert.match(worker,/const PRODUCTION_BRIDGE_COMMAND_TRANSPORT_ENABLED = false;/);
  assert.match(worker,/enableBridgeCommandTransport: PRODUCTION_BRIDGE_COMMAND_TRANSPORT_ENABLED/);
  assert.doesNotMatch(worker,/PRODUCTION_BRIDGE_COMMAND_TRANSPORT_ENABLED = (?:true|Boolean\(|env\.|request\.)/);
  assert.doesNotMatch(worker,/getTrustedGuardianPublicKey\s*:/);
});

test('even an opt-in transport must require an independent trusted signer',()=>{
  const gate='!options.enableBridgeCommandTransport || !options.getTrustedGuardianPublicKey';
  assert.equal(api.split(gate).length-1,4);
  assert.match(api,/GUARDIAN_RECEIPT_SIGNATURE_REQUIRED/);
  assert.match(api,/completeSignedBridgeModeCommand/);
  assert.doesNotMatch(worker,/\/api\/v1\/internal\/device\/bridge-command\/receipt/);
});
