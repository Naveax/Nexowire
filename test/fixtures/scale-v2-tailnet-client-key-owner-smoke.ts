/**
 * MANUAL DEV smoke. Owner accepts ONLY PUBLIC device key supplied by operator.
 * Device private key is created and held in memory on the separate Naveax PC.
 * Ephemeral fake account, temp test CA, private Tailnet-only TLS1.3, 75s stop.
 */
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {createHash,createPublicKey,randomBytes,X509Certificate} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProposedTrustedOwnerQuotaAuthority}
  from '../../src/product/trusted-owner-quota-authority-proposal.js';
import {startProposedOwnerQuotaLoopbackRpc}
  from '../../src/product/owner-quota-loopback-rpc-proposal.js';
import {startProposedOwnerQuotaOutboundWsHub}
  from '../../src/product/owner-quota-outbound-ws-proposal.js';

const ip=process.env.NEXOWIRE_DEV_TAILSCALE_IP??'';
const der=process.env.NEXOWIRE_DEV_CLIENT_PUBLIC_DER??'';
if(!/^100\./.test(ip)||!/^[A-Za-z0-9+/=]{40,512}$/.test(der)){
  throw new Error('Operator-pinned Tailnet IP and DEV PUBLIC DER key required');
}
const pub=createPublicKey({key:Buffer.from(der,'base64'),format:'der',type:'spki'});
if(pub.asymmetricKeyType!=='ed25519'||pub.type!=='public'){
  throw new Error('Enrollment must be an Ed25519 PUBLIC device key');
}
const pem=pub.export({format:'pem',type:'spki'}).toString();
const dir=mkdtempSync(path.join(tmpdir(),'nexowire-tailnet-held-key-'));
const output=path.join(tmpdir(),'nexowire-tailnet-held-key-readiness.json');
const certFile=path.join(dir,'temporary.crt');
const keyFile=path.join(dir,'temporary.key');
let rpc:Awaited<ReturnType<typeof startProposedOwnerQuotaLoopbackRpc>>|undefined;
let hub:Awaited<ReturnType<typeof startProposedOwnerQuotaOutboundWsHub>>|undefined;
let db:DatabaseSync|undefined;
try{
  execFileSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe',[
    'req','-x509','-newkey','rsa:2048','-sha256','-nodes',
    '-keyout',keyFile,'-out',certFile,'-days','1',
    '-subj','/CN=Nexowire-DEV-MemoryHeldKey',
    '-addext','subjectAltName=IP:'+ip,
    '-addext','basicConstraints=critical,CA:TRUE',
  ],{stdio:'ignore',timeout:22000});
  const cert=readFileSync(certFile,'utf8');
  const key=readFileSync(keyFile,'utf8');
  const pin=new X509Certificate(cert).fingerprint256
    .replaceAll(':','').toLowerCase();
  const accountId='dev-held-key-account-001';
  const deviceId='dev-held-key-device-001';
  const bearer=randomBytes(24).toString('base64url');
  db=new DatabaseSync(':memory:');
  for(const f of [
    'test/fixtures/scale-v2-owner-shared-quota-dev.sql',
    'test/fixtures/scale-v2-all-ingress-transport-staging.sql',
    'test/fixtures/scale-v2-owner-quota-rpc-dev.sql',
  ])db.exec(readFileSync(path.resolve(f),'utf8'));
  db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
    .run(accountId,'custom',100,1,1);
  db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
    .run(deviceId,accountId,1,'safe');
  db.prepare('INSERT INTO proposed_owner_rpc_device_keys VALUES(?,?,1)')
    .run(deviceId,pem);
  const auth=new ProposedTrustedOwnerQuotaAuthority(db,async t=>
    t===bearer?{accountId,sessionGeneration:1}:null);
  rpc=await startProposedOwnerQuotaLoopbackRpc({
    db,authority:auth,
    trustedToolCatalog:new Map([['dev-held-read-tool-001',{
      operationClass:'read',
      toolFingerprint:createHash('sha256').update('dev-memory-read').digest('hex'),
    }]]),
  });
  hub=await startProposedOwnerQuotaOutboundWsHub({
    trustedOwnerRpcOrigin:rpc.origin,stagingTailscaleIPv4:ip,
    tls:{certificatePem:cert,privateKeyPem:key},
  });
  writeFileSync(output,JSON.stringify({
    url:hub.url,certPem:cert,sha256:pin,bearerToken:bearer,
    deviceId,toolId:'dev-held-read-tool-001',accountId,
  }),'utf8');
  process.stdout.write('PRIVATE_DEVICE_HELD_WSS_READY '+hub.url+'\n');
  await new Promise<void>(resolve=>setTimeout(resolve,75_000));
}finally{
  try{await hub?.close()}catch{}
  try{await rpc?.close()}catch{}
  try{db?.close()}catch{}
  rmSync(output,{force:true});
  rmSync(dir,{recursive:true,force:true});
}
