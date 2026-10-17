/**
 * One-shot DEV smoke on the authorized operator Work PC.
 * Runs an in-memory fake account DB and ephemeral Ed25519 key. Binds ONLY
 * a pinned Tailscale adapter, and stops automatically after 45 seconds.
 * NO production billing/Agent/Hub or public Funnel changes.
 */
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../../src/product/trusted-owner-quota-authority-proposal.js';
import {
  startProposedOwnerQuotaLoopbackRpc,
  signDevOwnerQuotaRpcEnvelope,
} from '../../src/product/owner-quota-loopback-rpc-proposal.js';
import {startProposedOwnerQuotaTailscaleProxy}
  from '../../src/product/owner-quota-tailscale-proxy-proposal.js';

const readiness=path.join(tmpdir(),'nexowire-scale-v2-tailscale-smoke-ready.json');
const account='smoke-account-001',device='smoke-device-001';
const bearer=randomBytes(24).toString('base64url');
const fingerprint=createHash('sha256').update('trusted-owner-smoke-read').digest('hex');
const keys=generateKeyPairSync('ed25519');
const pub=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const priv=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const db=new DatabaseSync(':memory:');
const fixture=[
  'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
  'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
  'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
];
for(const f of fixture)db.exec(readFileSync(path.resolve(f),'utf8'));
db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
  .run(account,'custom',100,1,1);
db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
  .run(device,account,1,'safe');
db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
  .run(device,pub);

const authority=new ProposedTrustedOwnerQuotaAuthority(
  db,async token=>token===bearer?{accountId:account,sessionGeneration:1}:null);
let rpc:Awaited<ReturnType<typeof startProposedOwnerQuotaLoopbackRpc>>|undefined;
let proxy:Awaited<ReturnType<typeof startProposedOwnerQuotaTailscaleProxy>>|undefined;
async function closeAll(){
  try{rmSync(readiness,{force:true})}catch{}
  try{await proxy?.close()}catch{}
  try{await rpc?.close()}catch{}
  db.close();
}
try{
  rpc=await startProposedOwnerQuotaLoopbackRpc({
    db,authority,
    trustedToolCatalog:new Map([['smoke-read-v1',{
      operationClass:'read',toolFingerprint:fingerprint,
    }]]),
  });
  proxy=await startProposedOwnerQuotaTailscaleProxy({
    expectedTailscaleIPv4:process.env.NEXOWIRE_DEV_TAILSCALE_IP??'',
    trustedOwnerRpcOrigin:rpc.origin,
  });
  const now=Date.now();
  const envelope=signDevOwnerQuotaRpcEnvelope({
    envelope:{
      version:1,deviceId:device,
      nonce:'smoke-nonce-'+randomBytes(12).toString('hex'),
      issuedAtMs:now,
      body:{
        bearerToken:bearer,
        invocationId:'smoke-invocation-'+randomBytes(10).toString('hex'),
        toolId:'smoke-read-v1',
      },
    },
    devicePrivateKeyPem:priv,
  });
  writeFileSync(readiness,JSON.stringify({
    origin:proxy.origin,envelope,
    expiresAtMs:now+30000,
  }),'utf8');
  process.stdout.write('READY_ONLY_PRIVATE_TAILSCALE '+proxy.origin+'\n');
  await new Promise<void>(resolve=>setTimeout(resolve,45000));
} finally{
  await closeAll();
}
