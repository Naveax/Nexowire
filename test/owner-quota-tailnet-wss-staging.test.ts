import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyStagingQuotaWsUrl,startProposedOwnerQuotaOutboundWsHub,
  ProposedOutboundQuotaWsClient,
} from '../src/product/owner-quota-outbound-ws-proposal.js';

const route='/internal/owner-quota/v1/outbound';
const host='100.116.23.60';
test('operator pins expected Tailnet server address for outbound WSS',()=>{
  const correct='wss://'+host+':43199'+route;
  assert.equal(verifyStagingQuotaWsUrl(correct,true,host),correct);
  for(const url of [
    'ws://'+host+':43199'+route,
    'wss://100.88.128.85:43199'+route,
    'wss://127.0.0.1:43199'+route,
    'wss://192.168.1.1:43199'+route,
    'wss://'+host+':43199/agent',
    'wss://'+host+':43199'+route+'?spoof=1',
    'wss://attacker:secret@'+host+':43199'+route,
    'wss://'+host+':43199'+route+'#other',
  ])assert.throws(()=>verifyStagingQuotaWsUrl(url,true,host),url);
  assert.throws(()=>verifyStagingQuotaWsUrl(correct,true,'192.168.1.2'));
  assert.throws(()=>verifyStagingQuotaWsUrl(correct,false,host));
});
test('Tailnet WSS without TLS is refused before a listener starts',async()=>{
  await assert.rejects(startProposedOwnerQuotaOutboundWsHub({
    trustedOwnerRpcOrigin:'http://127.0.0.1:43123/internal/owner-quota/v1/reserve',
    stagingTailscaleIPv4:host,
  }),/requires TLS 1.3/);
});
test('nonexistent Tailnet interface or untrusted public/LAN bind fails closed',async()=>{
  for(const bad of ['100.0.0.1',
    '192.168.1.1','0.0.0.0','127.0.0.1']){
    await assert.rejects(startProposedOwnerQuotaOutboundWsHub({
      trustedOwnerRpcOrigin:'http://127.0.0.1:43123/internal/owner-quota/v1/reserve',
      stagingTailscaleIPv4:bad,
      tls:{certificatePem:'invalid',privateKeyPem:'invalid'},
    }),/Tailscale private|adapter missing/);
  }
});
test('production-like WSS client cannot connect to tailnet without owner identity pins',()=>{
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    'wss://'+host+':43199'+route),/STAGING WS|loopback/);
  assert.throws(()=>new ProposedOutboundQuotaWsClient(
    'wss://'+host+':43199'+route,
    {trustedCaPem:'INVALID',expectedLeafSha256:'0'.repeat(64),
      expectedTailscaleIPv4:host}),/Untrusted WSS/);
});
