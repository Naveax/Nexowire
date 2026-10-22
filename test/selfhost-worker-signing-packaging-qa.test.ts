/**
 * #41 SPECIFICATION-ONLY acceptance fixtures. No installed worker, Windows signer,
 * external enrollment CAS, OS token or physical protection is exercised here.
 * These checks are deliberately not an installer or grant issuer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign, verify, type KeyObject} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

type FixtureFile = {name:string;role:string;imports:string[];sha256:string;signature:string};
type FixtureManifest = {role:string;workerDeviceId:string;releaseSequence:number;files:FixtureFile[]};
type FixturePackage = {manifest:FixtureManifest;signature:string};
type FixtureSigner = {privateKey:KeyObject;publicKey:KeyObject};
type Enrollment = {role:string;ownerId:string;hostId:string;workerDeviceId:string;ownerEpoch:number;pairingEpoch:number;nonce:string;workerSpkiSha256:string;payload:{nonce:string};proof?:string};
type AuthoritySnapshot = {ownerId:string;hostId:string;workerDeviceId:string;ownerEpoch:number;pairingEpoch:number;externalAtomicWitness:boolean;revoked:boolean;consumedNonces:Set<string>;otherWorkerFingerprints:Set<string>};
type OsReport = {workerSid:string;agentSid:string;brokerSid:string;integrity:string;isElevated:boolean;canDuplicateBrokerHandle:boolean;canReadAgentSecrets:boolean;canWriteProtectedInstall:boolean;inheritsAgentEnvironment:boolean;outsideRootAccess:boolean;unrestrictedNetwork:boolean};

const digest = (data:Buffer|string) => createHash('sha256').update(data).digest('hex');
const signature = (key:KeyObject, data:Buffer|string) => sign(null, Buffer.from(data), key).toString('base64');
const cleanName = (name:unknown):name is string => typeof name === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,90}$/.test(name) && name !== '..';

// A synthetic cryptographic file/manifest verifier. Ed25519 fixture keys are
// exportable, not native Windows Authenticode or provisioned publisher pins.
function verifyFixturePackage(root:string, signed:FixturePackage, pinnedPublisher:KeyObject, trustedReleaseFloor:number):boolean {
  const m = signed?.manifest;
  if (!m || !Number.isSafeInteger(m.releaseSequence) || m.releaseSequence < trustedReleaseFloor ||
      m.releaseSequence < 1 || m.role !== 'coding-worker' || !cleanName(m.workerDeviceId) ||
      !Array.isArray(m.files) || m.files.length < 4 || m.files.length > 64) return false;
  if (!verify(null, Buffer.from(JSON.stringify(m)), pinnedPublisher,
      Buffer.from(signed.signature || '', 'base64'))) return false;
  const required = new Set(['worker', 'updater', 'rollback', 'dll']);
  const indexed = new Map<string,FixtureFile>();
  for (const entry of m.files) {
    if (!cleanName(entry?.name) || !required.has(entry.role) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
        !Array.isArray(entry.imports) || entry.imports.some(n => !cleanName(n))) return false;
    const lowered = entry.name.toLowerCase();
    if (indexed.has(lowered)) return false;
    indexed.set(lowered, entry);
  }
  for (const role of required) {
    if (!m.files.some(entry => entry.role === role)) return false;
  }
  const disk = readdirSync(root);
  if (disk.length !== indexed.size) return false;
  for (const name of disk) {
    if (!cleanName(name) || !indexed.has(name.toLowerCase())) return false;
    const item = lstatSync(path.join(root, name));
    if (!item.isFile() || item.isSymbolicLink()) return false;
  }
  for (const entry of m.files) {
    if (!disk.includes(entry.name)) return false;
    const bytes = readFileSync(path.join(root, entry.name));
    if (digest(bytes) !== entry.sha256) return false;
    if (!verify(null, bytes, pinnedPublisher,
      Buffer.from(entry.signature || '', 'base64'))) return false;
    for (const dep of entry.imports) if (!indexed.has(dep.toLowerCase())) return false;
  }
  return true;
}

function fixturePackage(root:string, publisher:FixtureSigner):FixturePackage {
  const components:{name:string;role:string;imports:string[]}[] = [
    {name:'coding-worker.exe', role:'worker', imports:['engine.dll']},
    {name:'engine.dll', role:'dll', imports:[]},
    {name:'worker-updater.exe', role:'updater', imports:['engine.dll']},
    {name:'worker-rollback.exe', role:'rollback', imports:['engine.dll']},
  ];
  const files = components.map(entry => {
    const bytes = Buffer.from('fixture-only:' + entry.name);
    writeFileSync(path.join(root, entry.name), bytes);
    return {...entry, sha256:digest(bytes), signature:signature(publisher.privateKey,bytes)};
  });
  const manifest = {role:'coding-worker', workerDeviceId:'worker-a', releaseSequence:7, files};
  return {manifest,signature:signature(publisher.privateKey,JSON.stringify(manifest))};
}
const resign = (signed:FixturePackage, publisher:FixtureSigner) => {
  signed.signature = signature(publisher.privateKey, JSON.stringify(signed.manifest));
};

// Enrollment simulation cannot provide or emulate durable off-host CAS.
// It validates duplicate-key/nonce/epoch rejections only. No install-positive API.
function rejectUnsafeEnrollment(req:Enrollment, authoritativeSnapshot:AuthoritySnapshot|null, workerPublicKey:KeyObject):string {
  if (!authoritativeSnapshot || !Number.isSafeInteger(authoritativeSnapshot.ownerEpoch) ||
      !authoritativeSnapshot.externalAtomicWitness) return 'EXTERNAL_CAS_REQUIRED';
  if (req.role !== 'coding-worker' || req.ownerId !== authoritativeSnapshot.ownerId ||
      req.workerDeviceId !== authoritativeSnapshot.workerDeviceId ||
      req.hostId !== authoritativeSnapshot.hostId ||
      req.ownerEpoch !== authoritativeSnapshot.ownerEpoch ||
      req.pairingEpoch !== authoritativeSnapshot.pairingEpoch) return 'IDENTITY_OR_EPOCH_STALE';
  if (req.workerSpkiSha256 !== digest(workerPublicKey.export({type:'spki',format:'der'})))
    return 'WORKER_SIGNER_MISMATCH';
  if (authoritativeSnapshot.revoked || authoritativeSnapshot.consumedNonces.has(req.nonce) ||
      authoritativeSnapshot.otherWorkerFingerprints.has(req.workerSpkiSha256))
    return 'REVOKED_REPLAY_OR_KEY_REUSE';
  if (!verify(null,Buffer.from(JSON.stringify(req.payload)),workerPublicKey,
      Buffer.from(req.proof || '', 'base64'))) return 'FORGED_WORKER_PROOF';
  return 'EXTERNAL_CAS_REQUIRED';
}

const allowedCheckpointKeys = new Set([
  'schemaVersion', 'ownerId', 'workerDeviceId', 'taskId', 'worktreeId',
  'sourceSha', 'ownerEpoch', 'pairingEpoch', 'logicalMutationId',
  'requestId', 'remainingBudget', 'pendingUnknown', 'receiptSha256',
]);
function checkCheckpointMetadata(snapshot:Record<string,unknown>|null):boolean {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      Object.keys(snapshot).some(key => !allowedCheckpointKeys.has(key))) return false;
  if (snapshot.schemaVersion !== 1 || snapshot.pendingUnknown !== true ||
      typeof snapshot.sourceSha !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sourceSha) ||
      typeof snapshot.receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.receiptSha256) ||
      !Number.isSafeInteger(snapshot.ownerEpoch) ||
      !Number.isSafeInteger(snapshot.pairingEpoch) ||
      !Number.isSafeInteger(snapshot.remainingBudget) || typeof snapshot.remainingBudget !== 'number' || snapshot.remainingBudget < 0) return false;
  for (const field of ['ownerId','workerDeviceId','taskId','worktreeId','logicalMutationId','requestId']) {
    if (!cleanName(snapshot[field])) return false;
  }
  return true;
}

function syntheticOsBoundary(evidence:OsReport|null):string {
  if (!evidence || evidence.workerSid === evidence.agentSid ||
      evidence.workerSid === evidence.brokerSid ||
      !/^S-1-5-21-/.test(evidence.workerSid || '') ||
      !['low','medium'].includes(evidence.integrity) ||
      evidence.isElevated || evidence.canDuplicateBrokerHandle ||
      evidence.canReadAgentSecrets || evidence.canWriteProtectedInstall ||
      evidence.inheritsAgentEnvironment || evidence.outsideRootAccess ||
      evidence.unrestrictedNetwork) return 'DENIED';
  return 'PHYSICAL_TOKEN_AND_KERNEL_WITNESS_REQUIRED';
}

const withPackage = (fn:(dir:string,publisher:FixtureSigner,pkg:FixturePackage)=>void):void => {
  const dir = mkdtempSync(path.join(tmpdir(),'nw41-selfhost-fixture-'));
  const publisher = generateKeyPairSync('ed25519');
  try {return fn(dir,publisher,fixturePackage(dir,publisher));}
  finally {rmSync(dir,{recursive:true,force:true});}
};

test('#41 reference fixture: cryptographic manifest cannot grant native install',()=>withPackage((dir,key,pkg)=>{
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),true);
  assert.equal(syntheticOsBoundary({workerSid:'S-1-5-21-100',agentSid:'S-1-5-21-200',
    brokerSid:'S-1-5-18',integrity:'low',isElevated:false,
    canDuplicateBrokerHandle:false,canReadAgentSecrets:false,
    canWriteProtectedInstall:false,inheritsAgentEnvironment:false,
    outsideRootAccess:false,unrestrictedNetwork:false}),
  'PHYSICAL_TOKEN_AND_KERNEL_WITNESS_REQUIRED');
}));

test('#41 rejects replaced EXE and imported DLL even with unchanged signed manifest',()=>withPackage((dir,key,pkg)=>{
  writeFileSync(path.join(dir,'coding-worker.exe'),'swapped binary');
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
  writeFileSync(path.join(dir,'coding-worker.exe'),'fixture-only:coding-worker.exe');
  writeFileSync(path.join(dir,'engine.dll'),'swapped dll');
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
}));

test('#41 rejects unsigned updater/rollback, and a rogue DLL outside import closure',()=>withPackage((dir,key,pkg)=>{
  pkg.manifest.files.find(f=>f.role==='rollback')!.signature='';
  resign(pkg,key);
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
  pkg.manifest.files.find(f=>f.role==='rollback')!.signature=signature(key.privateKey,Buffer.from('fixture-only:worker-rollback.exe'));
  pkg.manifest.files.find(f=>f.role==='updater')!.signature='';
  resign(pkg,key);
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
  pkg.manifest.files.find(f=>f.role==='updater')!.signature=signature(key.privateKey,Buffer.from('fixture-only:worker-updater.exe'));
  resign(pkg,key);
  writeFileSync(path.join(dir,'injected.dll'),'injected');
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
}));

test('#41 rejects signed manifest with missing/delay import, and unpinned package publisher',()=>withPackage((dir,key,pkg)=>{
  pkg.manifest.files[0]!.imports.push('missing-delay.dll');
  resign(pkg,key);
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
  pkg.manifest.files[0]!.imports.pop();
  resign(pkg,key);
  const attacker = generateKeyPairSync('ed25519');
  assert.equal(verifyFixturePackage(dir,pkg,attacker.publicKey,7),false);
}));

test('#41 rejects path traversal, case collision, symlink and directory in package',()=>withPackage((dir,key,pkg)=>{
  pkg.manifest.files[0]!.name='../escape.exe';
  resign(pkg,key);
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
  pkg.manifest.files[0]!.name='coding-worker.exe';
  pkg.manifest.files.push({...pkg.manifest.files[0]!,name:'CODING-WORKER.EXE'});
  resign(pkg,key);
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
  pkg.manifest.files.pop();resign(pkg,key);
  rmSync(path.join(dir,'engine.dll'));
  // On Windows, a normal test-user may not have symlink creation privileges.
  // A directory substitute must still be rejected without needing that right.
  try {
    symlinkSync(path.join(dir,'coding-worker.exe'),path.join(dir,'engine.dll'));
    assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
    rmSync(path.join(dir,'engine.dll'));
  } catch (error) {
    const code=(error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EPERM','EACCES'].includes(code || '')) throw error;
  }
  mkdirSync(path.join(dir,'engine.dll'));
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
}));

test('#41 rejects release downgrade despite a valid test signature',()=>withPackage((dir,key,pkg)=>{
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,8),false);
  pkg.manifest.releaseSequence=6;
  resign(pkg,key);
  assert.equal(verifyFixturePackage(dir,pkg,key.publicKey,7),false);
}));

test('#41 duplicate enrollment nonce, reused worker key and revoke fail closed in fixture',()=>{
  const worker=generateKeyPairSync('ed25519');
  const spki=digest(worker.publicKey.export({type:'spki',format:'der'}));
  const req:Enrollment={ownerId:'owner-a',hostId:'host-a',workerDeviceId:'worker-a',role:'coding-worker',
    ownerEpoch:5,pairingEpoch:6,nonce:'once-a',workerSpkiSha256:spki,payload:{nonce:'once-a'}};
  req.proof=signature(worker.privateKey,JSON.stringify(req.payload));
  const snapshot:AuthoritySnapshot={ownerId:'owner-a',hostId:'host-a',workerDeviceId:'worker-a',ownerEpoch:5,
    pairingEpoch:6,externalAtomicWitness:true,revoked:false,
    consumedNonces:new Set(),otherWorkerFingerprints:new Set()};
  assert.equal(rejectUnsafeEnrollment(req,{...snapshot,consumedNonces:new Set(['once-a'])},worker.publicKey),'REVOKED_REPLAY_OR_KEY_REUSE');
  assert.equal(rejectUnsafeEnrollment(req,{...snapshot,otherWorkerFingerprints:new Set([spki])},worker.publicKey),'REVOKED_REPLAY_OR_KEY_REUSE');
  assert.equal(rejectUnsafeEnrollment(req,{...snapshot,revoked:true},worker.publicKey),'REVOKED_REPLAY_OR_KEY_REUSE');
  assert.equal(rejectUnsafeEnrollment(req,{...snapshot,pairingEpoch:7},worker.publicKey),'IDENTITY_OR_EPOCH_STALE');
  assert.equal(rejectUnsafeEnrollment({...req,ownerId:'other'},snapshot,worker.publicKey),'IDENTITY_OR_EPOCH_STALE');
  assert.equal(rejectUnsafeEnrollment({...req,proof:signature(generateKeyPairSync('ed25519').privateKey,JSON.stringify(req.payload))},snapshot,worker.publicKey),'FORGED_WORKER_PROOF');
  assert.equal(rejectUnsafeEnrollment(req,null,worker.publicKey),'EXTERNAL_CAS_REQUIRED');
  assert.equal(rejectUnsafeEnrollment(req,snapshot,worker.publicKey),'EXTERNAL_CAS_REQUIRED');
});

test('#41 synthetic OS report refuses Agent/Broker SID, elevation and inherited handle',()=>{
  const base={workerSid:'S-1-5-21-100',agentSid:'S-1-5-21-200',brokerSid:'S-1-5-18',
    integrity:'low',isElevated:false,canDuplicateBrokerHandle:false,
    canReadAgentSecrets:false,canWriteProtectedInstall:false,
    inheritsAgentEnvironment:false,outsideRootAccess:false,unrestrictedNetwork:false};
  for (const patch of [{workerSid:base.agentSid},{workerSid:base.brokerSid},
    {integrity:'high'},{isElevated:true},{canDuplicateBrokerHandle:true},
    {canReadAgentSecrets:true},{canWriteProtectedInstall:true},
    {inheritsAgentEnvironment:true},{outsideRootAccess:true},{unrestrictedNetwork:true}]) {
    assert.equal(syntheticOsBoundary({...base,...patch}),'DENIED',JSON.stringify(patch));
  }
});

test('#41 checkpoint denies any raw token/private material or replayable grant field',()=>{
  const checkpoint={schemaVersion:1,ownerId:'owner-a',workerDeviceId:'worker-a',taskId:'task-a',
    worktreeId:'tree-a',sourceSha:'a'.repeat(64),ownerEpoch:5,pairingEpoch:6,
    logicalMutationId:'mutation-a',requestId:'request-a',remainingBudget:12,
    pendingUnknown:true,receiptSha256:'b'.repeat(64)};
  assert.equal(checkCheckpointMetadata(checkpoint),true);
  for(const field of ['token','bearer','refreshToken','privateKey','env','rawOutput','approval','grant','command'])
    assert.equal(checkCheckpointMetadata({...checkpoint,[field]:'SECRET'}),false,field);
  assert.equal(checkCheckpointMetadata({...checkpoint,pendingUnknown:false}),false);
  assert.equal(checkCheckpointMetadata({...checkpoint,sourceSha:'old SHA'}),false);
  assert.equal(checkCheckpointMetadata({...checkpoint,ownerEpoch:null}),false);
});
