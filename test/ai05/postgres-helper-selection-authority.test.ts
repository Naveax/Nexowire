import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PostgresHelperSelectionAuthority,createHelperSelectionLeaseProvider,type HelperAuthorityEvidenceRequest,type HelperAuthorityScope,type HelperSelectionLeaseTransport} from '../../src/security/postgres-helper-selection-authority.js';
import {runTransferHelperLifecycle,type HelperSelection,type HelperRequest,type TransferHelperArtifactStore} from '../../src/installer/protected-transfer-helper-lifecycle.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';

const a={sha256:'a'.repeat(64),signerSha256:'1'.repeat(64)},b={sha256:'b'.repeat(64),signerSha256:'2'.repeat(64)};
const requested=process.env.NEXOWIRE_HELPER_SELECTION_PG_FIXTURE==='1';
const req=(operation:HelperRequest['operation'],expected:HelperSelection,desired:HelperRequest['desired'],sourcePath?:string):HelperRequest=>({requestId:randomUUID(),operation,expected,desired,...(sourcePath===undefined?{}:{sourcePath})});
test('durable independent helper selection excludes runtime/deployment, preserves revisions and denies replay/revocation',{
  skip:!requested,timeout:120000,
},async t=>{
  assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const port=Number(process.env.NEXOWIRE_HELPER_SELECTION_PG_PORT);assert(Number.isInteger(port)&&port>0&&port<65536);
  const common={host:'127.0.0.1',port,database:'nexowire_helper_ci',password:'fixture-only-not-production',max:4,connectionTimeoutMillis:3000};
  const admin=new Pool({...common,user:'nexowire_helper_ci'});
  const pools:Pool[]=[admin];t.after(async()=>{await Promise.all(pools.map(p=>p.end()));});
  await admin.query(await readFile('sql/core-broker-dispatch-authority.sql','utf8'));
  await admin.query(await readFile('sql/helper-selection-authority.sql','utf8'));
  await admin.query("CREATE ROLE helper_fixture_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-only-not-production'");
  await admin.query("GRANT USAGE ON SCHEMA core_dispatch,helper_selection TO helper_fixture_runtime; GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,helper_selection.selections,helper_selection.leases TO helper_fixture_runtime; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO helper_fixture_runtime; GRANT INSERT ON helper_selection.leases TO helper_fixture_runtime; GRANT UPDATE(state,committed_revision) ON helper_selection.leases TO helper_fixture_runtime; GRANT UPDATE(revision,sha256,signer_sha256) ON helper_selection.selections TO helper_fixture_runtime");
  const scope:HelperAuthorityScope={authorityId:randomUUID(),deviceId:randomUUID(),ownerId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:1,generation:1,brokerId:randomUUID()};
  const values=[scope.authorityId,scope.deviceId,scope.ownerId,scope.deviceEpoch,scope.sessionEpoch,scope.ownerEpoch,scope.generation,scope.brokerId];
  await admin.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',[scope.authorityId,Date.now()-1000]);
  await admin.query("INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')",values);
  let current:HelperSelection={revision:randomUUID(),pin:null};
  await admin.query('INSERT INTO helper_selection.selections(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...values,current.revision]);
  let allowRelease=true,allowCommit=true;
  const verifyEvidence=async(v:HelperAuthorityEvidenceRequest)=>{
    assert.deepEqual(v.scope,scope);
    return v.phase==='RELEASE'?allowRelease:v.phase==='COMMIT'?allowCommit:true;
  };
  function backend(){
    const pool=new Pool({...common,user:'helper_fixture_runtime'});pools.push(pool);
    return new PostgresHelperSelectionAuthority({pool:pool as unknown as DispatchStorePool,scope,verifyEvidence,
      verifyProvenance:async()=>({verified:true,authorityId:scope.authorityId,validUntil:Date.now()+60000})});
  }
  const first=backend(),second=backend(),provider=createHelperSelectionLeaseProvider(first);
  const stored=new Set<string>();
  const store:TransferHelperArtifactStore={
    async stage(_file,p){stored.add(p.sha256);},
    async verifyInstalled(p){assert(stored.has(p.sha256));},
  };
  const install=req('clean-install',current,a,'inert fixture A');
  const installed=await runTransferHelperLifecycle(install,provider,store);
  current=installed.selection;assert.deepEqual(current.pin,a);
  await assert.rejects(first.beginDeployment(install),/STALE|REPLAY/);
  const runtimeRequest=randomUUID();
  const runtime=await first.beginRuntime(runtimeRequest);
  await assert.rejects(second.beginDeployment(req('upgrade',current,b,'inert fixture B')),/LEASE_OCCUPIED/);
  await assert.rejects(second.beginRuntime(randomUUID()),/LEASE_OCCUPIED/);
  assert.deepEqual(await second.read(runtime.id),current);
  allowRelease=false;await assert.rejects(second.release(runtime.id),/EVIDENCE_DENIED/);
  const recreated=backend();await assert.rejects(recreated.beginRuntime(randomUUID()),/LEASE_OCCUPIED/);
  allowRelease=true;await recreated.release(runtime.id);
  await assert.rejects(second.beginRuntime(runtimeRequest),/REQUEST_REPLAY/);
  const upgrade=req('upgrade',current,b,'inert fixture B');
  const races=await Promise.allSettled([first.beginDeployment(upgrade),second.beginDeployment(req('upgrade',current,b,'inert fixture B'))]);
  assert.equal(races.filter(v=>v.status==='fulfilled').length,1);
  for(const result of races)if(result.status==='fulfilled')await second.release(result.value.id);
  const up=await runTransferHelperLifecycle(req('upgrade',current,b,'inert fixture B'),provider,store);current=up.selection;
  assert.deepEqual(current.pin,b);
  const rollback=await runTransferHelperLifecycle(req('rollback',current,a),provider,store);current=rollback.selection;
  assert.deepEqual(current.pin,a);assert.equal(stored.size,2);
  const stale=await first.beginDeployment(req('uninstall',current,null));
  allowCommit=false;
  // Exact original request hash required; changed request ID cannot commit.
  await assert.rejects(first.commit(stale.id,req('uninstall',current,null)),/COMMIT_FENCED/);
  await second.release(stale.id);allowCommit=true;
  const detached=await runTransferHelperLifecycle(req('uninstall',current,null),provider,store);current=detached.selection;
  assert.equal(current.pin,null);assert.equal(stored.size,2);
  await assert.rejects(first.beginRuntime(randomUUID()),/NOT_SELECTED/);
  const again=await runTransferHelperLifecycle(req('clean-install',current,a,'inert fixture A'),provider,store);current=again.selection;
  const pending=await first.beginRuntime(randomUUID());
  await admin.query('BEGIN');
  try{
    await admin.query('SELECT authority_id FROM core_dispatch.authorities WHERE authority_id=$1 FOR UPDATE',[scope.authorityId]);
    await admin.query("UPDATE core_dispatch.grants SET state='REVOKED' WHERE authority_id=$1 AND device_id=$2",[scope.authorityId,scope.deviceId]);
    await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK');throw e;}
  await assert.rejects(second.read(pending.id),/GRANT_FENCED/);
  await assert.rejects(second.release(pending.id),/GRANT_FENCED/);
  assert.equal((await admin.query('SELECT state FROM helper_selection.leases WHERE id=$1',[pending.id])).rows[0].state,'ACTIVE');
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM helper_selection.leases WHERE state<>'RELEASED'")).rows[0].n,1);
  t.diagnostic('Real PostgreSQL durable selection, cross-pool exclusion, replay, rollback/detach and revoke fence verified; external evidence and file store are fixture-only');
});
test('provider retains lease on callback failure and refuses nested local acquisition',async()=>{
  const id=randomUUID(),revision=randomUUID();let releases=0,begins=0;
  const transport:HelperSelectionLeaseTransport={
    async beginRuntime(requestId){begins++;return {id,requestId,kind:'RUNTIME',expectedRevision:revision};},
    async beginDeployment(){throw Error('unexpected');},
    async read(){return {revision,pin:a};},
    async commit(){throw Error('unexpected');},
    async release(){releases++;},
  };
  const provider=createHelperSelectionLeaseProvider(transport);
  await assert.rejects(provider.withActiveSelection(async()=>{
    await assert.rejects(provider.withActiveSelection(async()=>{}),/SCOPE_BUSY/);
    throw Error('callback failure');
  }),/callback failure/);
  assert.equal(begins,1);assert.equal(releases,0);
  await assert.rejects(provider.readSelection(),/LEASE_REQUIRED/);
});
