import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CredentialStore} from '../src/security/credential-store.js';
import {
  inspectProtectedSecretFile,
  readProtectedSecretFile,
  writeProtectedSecretFile,
} from '../src/security/protected-secret-files.js';
import {compareOfflineHubStateCopyReadOnly} from '../scripts/ai04-offline-migration-integrity.js';

const windows=process.platform==='win32';

async function syntheticState(root:string):Promise<void>{
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'audit.jsonl'),'{"fixture":true}\n');
  await fs.writeFile(path.join(root,'devices.json'),'{"devices":[]}');
  await fs.writeFile(path.join(root,'idempotency-records.json'),'{}');
  await fs.writeFile(path.join(root,'workspace-'+('e'.repeat(64))+'.json'),'{"workspace":"fixture"}');
  await fs.mkdir(path.join(root,'ai04-recovery-backups'));
  await fs.writeFile(path.join(root,'ai04-recovery-backups','recovery.json'),'{"backup":true}');
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO idempotency_records(key) VALUES(?)').run('synthetic');
  }finally{db.close()}
}

test('full-state copy retains MCP/Agent hashed credential authorization and revocation',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-credential-continuity-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),destination=path.join(parent,'destination');
  await syntheticState(source);
  const original=new CredentialStore(source);
  await original.initialize();
  const mcp=await original.issue('mcp',{role:'admin',allowedTools:['agent.operation.status']});
  const agent=await original.issue('agent',{name:'fixture-agent'});
  const revoked=await original.issue('mcp',{name:'fixture-revoked'});
  await original.revoke(revoked.credential.id);

  // This is a disposable, writer-free fixture. The production migration still
  // requires a separately authorized offline copy and independent ACL checks.
  await fs.cp(source,destination,{recursive:true});
  const audit=await compareOfflineHubStateCopyReadOnly(source,destination);
  assert.equal(audit.contentIdentical,true);
  assert.equal(audit.readyForSystemCutover,false);

  const migrated=new CredentialStore(destination);
  await migrated.initialize();
  assert.equal(migrated.authenticate('mcp',mcp.token)?.role,'admin');
  assert.equal(migrated.authenticate('mcp',mcp.token)?.id,mcp.credential.id);
  assert.equal(migrated.verify('agent',agent.token),true);
  assert.equal(migrated.verify('mcp',agent.token),false);
  assert.equal(migrated.verify('mcp',revoked.token),false);
  assert.equal(migrated.list({includeRevoked:true}).length,3);
  assert.equal(migrated.hasUsable('mcp'),true);

  const raw=await fs.readFile(path.join(destination,'credentials.json'),'utf8');
  for(const token of [mcp.token,agent.token,revoked.token]){
    assert.equal(raw.includes(token),false,'Credential plaintext must never enter transferred JSON');
  }
  assert.match(raw,/"tokenHash": "[a-f0-9]{64}"/);
  assert.equal(await fs.readFile(path.join(source,'credentials.json'),'utf8'),raw);
});

test('CurrentUser to LocalMachine DPAPI rewrap preserves synthetic purpose and secret',{
  skip:!windows,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-dpapi-rewrap-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'current-user.dpapi.json');
  const destination=path.join(root,'local-machine.dpapi.json');
  const purpose='control-plane-service-token';
  const synthetic='synthetic-nexowire-service-token-'+('z'.repeat(44));
  await writeProtectedSecretFile(source,purpose,synthetic,{scope:'current-user'});
  assert.equal(inspectProtectedSecretFile(source).protection,'windows-dpapi-current-user');
  const original=readProtectedSecretFile(source,purpose,'synthetic source');
  assert.equal(original,synthetic);
  await writeProtectedSecretFile(destination,purpose,original,{scope:'local-machine'});
  const machine=inspectProtectedSecretFile(destination);
  assert.equal(machine.protection,'windows-dpapi-local-machine');
  assert.equal(machine.purpose,purpose);
  assert.equal(readProtectedSecretFile(destination,purpose,'synthetic destination'),synthetic);
  const oldEnvelope=await fs.readFile(source,'utf8');
  const newEnvelope=await fs.readFile(destination,'utf8');
  assert.equal(oldEnvelope.includes(synthetic),false);
  assert.equal(newEnvelope.includes(synthetic),false);
  assert.notEqual(oldEnvelope,newEnvelope);
  // This checks only local-user rewrap. It does NOT prove a SYSTEM token,
  // protected ProgramData ACL, live Hub auth or unattended reboot.
});
