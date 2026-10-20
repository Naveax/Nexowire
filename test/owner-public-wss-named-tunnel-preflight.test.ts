import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectNamedTunnelOfflinePreflight,
} from '../src/product/owner-public-wss-named-tunnel-preflight-proposal.js';

const correct={
  accountId:'a'.repeat(32),zoneId:'b'.repeat(32),
  tunnelId:'23456789-abcd-4abc-8abc-123456789012',
  zoneName:'example.com',hostname:'edge.example.com',
  edgeCertificateMode:'operator-custom' as const,
  profile:{
    endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
    expectedHostname:'edge.example.com',
    trustedSpkiSha256:['c'.repeat(64)],
    caMode:'system' as const,
  },
};
test('missing Cloudflare ownership data is blocked, never marked production accepted',()=>{
  const result=inspectNamedTunnelOfflinePreflight(undefined);
  assert.equal(result.stage,'BLOCKED');
  assert.equal(result.productionAccepted,false);
  assert.ok(result.missingOrInvalid.length>=5);
});
test('complete-looking offline configuration does not certify account ownership',()=>{
  const result=inspectNamedTunnelOfflinePreflight(correct);
  assert.equal(result.stage,'OFFLINE_PREFLIGHT_ONLY');
  assert.equal(result.productionAccepted,false);
  assert.ok(result.requiredLiveProof.length>=5);
});
test('temporary Cloudflare hostname and untrusted public zone are not Named Tunnel evidence',()=>{
  const result=inspectNamedTunnelOfflinePreflight({
    ...correct,zoneName:'trycloudflare.com',
    hostname:'test.trycloudflare.com',
    profile:{...correct.profile,
      endpoint:'wss://test.trycloudflare.com/internal/owner-quota/v1/outbound',
      expectedHostname:'test.trycloudflare.com',
    },
  });
  assert.equal(result.stage,'BLOCKED');
  assert.equal(result.productionAccepted,false);
});
test('managed edge SPKI rotation and endpoint/hostname mismatch block readiness',()=>{
  const result=inspectNamedTunnelOfflinePreflight({
    ...correct,edgeCertificateMode:'cloudflare-managed',
    profile:{...correct.profile,
      endpoint:'wss://other.example.com/internal/owner-quota/v1/outbound',
      expectedHostname:'other.example.com',
    },
  });
  assert.equal(result.stage,'BLOCKED');
  assert.ok(result.missingOrInvalid.includes(
    'cloudflare_managed_edge_spki_rotation_unresolved',
  ));
  assert.ok(result.missingOrInvalid.includes('signed_profile_hostname_mismatch'));
});
