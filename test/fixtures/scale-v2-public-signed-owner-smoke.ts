/**
 * Short-lived physical Cloudflare Quick Tunnel validation (DEV ONLY).
 * Synthetic account, synthetic bearer and Naveax-held DEV Ed25519 key.
 * NOT a production listener, OAuth provider or native tool dispatcher.
 */
import {DatabaseSync} from 'node:sqlite';
import {createHash,createPublicKey,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../../src/product/trusted-owner-quota-authority-proposal.js';
import {startProposedOwnerQuotaLoopbackRpc}
  from '../../src/product/owner-quota-loopback-rpc-proposal.js';
import {startProposedOwnerQuotaOutboundWsHub}
  from '../../src/product/owner-quota-outbound-ws-proposal.js';

const der=process.env.NEXOWIRE_DEV_CLIENT_PUBLIC_DER??'';
const out=process.env.NEXOWIRE_DEV_PUBLIC_WSS_OWNER_READY_FILE??'';
if(!/^[A-Za-z0-9+/=]{40,512}$/.test(der) || !path.isAbsolute(out)){
  throw new Error('Explicit public client DER and temporary output path required');
}
const publicKey=createPublicKey({key:Buffer.from(der,'base64'),format:'der',type:'spki'});
if(publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519'){
  throw new Error('Only registered synthetic Ed25519 public keys accepted');
}
const accountId='public-smoke-account-0001';
const deviceId='public-smoke-device-0001';
const toolId='public-smoke-read-tool-0001';
const bearerToken=randomBytes(32).toString('base64url');
const db=new DatabaseSync(':memory:');
let rpc:Awaited<ReturnType<typeof startProposedOwnerQuotaLoopbackRpc>>|undefined;
let ws:Awaited<ReturnType<typeof startProposedOwnerQuotaOutboundWsHub>>|undefined;
try{
  for(const f of [
    'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
  ]) db.exec(readFileSync(path.resolve(f),'utf8'));
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(accountId,'custom',100,1,1);
  db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
    .run(deviceId,accountId,1,'safe');
  db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
    .run(deviceId,publicKey.export({format:'pem',type:'spki'}).toString());
  const authority=new ProposedTrustedOwnerQuotaAuthority(
    db,async t=>t===bearerToken?{accountId,sessionGeneration:1}:null,
  );
  rpc=await startProposedOwnerQuotaLoopbackRpc({
    db,authority,
    trustedToolCatalog:new Map([[toolId,{
      operationClass:'read',
      toolFingerprint:createHash('sha256').update(
        'dev-public-owner-wss-read-only-tool',
      ).digest('hex'),
    }]]),
  });
  ws=await startProposedOwnerQuotaOutboundWsHub({
    trustedOwnerRpcOrigin:rpc.origin,
  });
  const url=new URL(ws.url);
  if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||
    url.pathname!=='/internal/owner-quota/v1/outbound'){
    throw new Error('Owner WSS smoke bound to an unexpected destination');
  }
  writeFileSync(out,JSON.stringify({
    originPort:Number(url.port), path:url.pathname,
    accountId,deviceId,toolId,bearerToken,
  })+'\n',{flag:'wx'});
  process.stdout.write('READ_ONLY_SIGNED_OWNER_QUOTA_STAGING_READY\n');
  // The managed test process should be terminated explicitly on completion.
  await new Promise<void>(resolve=>setTimeout(resolve,180_000));
}finally{
  try{await ws?.close()}catch{}
  try{await rpc?.close()}catch{}
  db.close();
}
