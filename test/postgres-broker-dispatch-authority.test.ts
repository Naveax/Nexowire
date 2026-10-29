import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import * as tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {BrokerExternalDispatchFence,type BrokerDispatchRequest,type DispatchClaim,
  type ProtectedBrokerEvidence} from '../src/agent/broker-external-dispatch-fence.js';
import {PostgresBrokerDispatchAuthority,type DispatchStorePool}
  from '../src/agent/postgres-broker-dispatch-authority.js';
import {createProtectedPostgresDispatchPool} from '../src/agent/protected-postgres-dispatch-pool.js';
import {createBrokerDispatchAuthorityHandler} from '../src/agent/broker-dispatch-authority-handler.js';
import {HttpsBrokerDispatchAuthority} from '../src/agent/https-broker-dispatch-authority.js';

// Only disposable CI PostgreSQL. Native identity, signer and independent
// provenance below are explicit fixtures, NEVER physical production evidence.
const enabled=process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION==='1';
const restartPhase=process.env.NEXOWIRE_PG_DISPATCH_RESTART_PHASE;
const integration={skip:!enabled?'DISPOSABLE_POSTGRES_NOT_REQUESTED; production NOT_PROVEN':false,
  timeout:30000};
const keys=generateKeyPairSync('ed25519');
const privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const nonce=()=>'a'.repeat(64);
const denied=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code===code;
function decoded(claim:DispatchClaim):Record<string,unknown>{
  const bytes=Buffer.from(claim.payload,'base64url');
  assert.equal(verify(null,bytes,keys.publicKey,Buffer.from(claim.signature,'base64url')),true);
  return JSON.parse(bytes.toString('utf8')) as Record<string,unknown>;
}
async function fixture(options:{permitMs?:number;drainTimeoutMs?:number}={}){
  assert.equal(enabled,true);
  const port=Number(process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT??'5432');
  assert.ok(Number.isInteger(port)&&port>0&&port<65536);
  const pool=new Pool({host:'127.0.0.1',port,database:'nexowire_dispatch_ci',
    user:'nexowire_dispatch_ci',password:'ci-only-not-a-production-credential',max:8,
    connectionTimeoutMillis:3000,idleTimeoutMillis:1000});
  try{
    await pool.query(await readFile(new URL('../sql/core-broker-dispatch-authority.sql',import.meta.url),'utf8'));
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexowire_dispatch_runtime') THEN "+
      "CREATE ROLE nexowire_dispatch_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION "+
      "NOBYPASSRLS PASSWORD 'ci-only-not-a-production-credential'; END IF; END $$;");
    await pool.query('GRANT USAGE ON SCHEMA core_dispatch TO nexowire_dispatch_runtime; '+
      'GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,core_dispatch.claims TO nexowire_dispatch_runtime; '+
      'GRANT UPDATE(sequence,max_seen_ms) ON core_dispatch.authorities TO nexowire_dispatch_runtime; '+
      'GRANT UPDATE(state,generation,core_enabled,root_expires_ms) ON core_dispatch.grants TO nexowire_dispatch_runtime; '+
      'GRANT INSERT ON core_dispatch.claims TO nexowire_dispatch_runtime; '+
      'GRANT UPDATE(state,commit_nonce,commit_expires_ms) ON core_dispatch.claims TO nexowire_dispatch_runtime;');
  }catch(error){await pool.end();throw error;}
  const ids={authorityId:randomUUID(),ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),brokerId:randomUUID()};
  await pool.query('INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES($1,$2)',
    [ids.authorityId,Date.now()-1000]);
  await pool.query('INSERT INTO core_dispatch.grants '+
    '(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state,core_enabled) '+
    "VALUES($1,$2,$3,$4,$5,4,7,$6,'ACTIVE',true)",
    [ids.authorityId,ids.deviceId,ids.ownerId,ids.deviceEpoch,ids.sessionEpoch,ids.brokerId]);
  const broker:ProtectedBrokerEvidence={verified:true,brokerId:ids.brokerId,ownerEpoch:4,
    grantGeneration:7,highIntegrityToken:true,signedProtectedImage:true,protectedParentAndImports:true};
  let high=true,provenance=true,nativeDrain=true;
  const servicePool=new Pool({host:'127.0.0.1',port,database:'nexowire_dispatch_ci',
    user:'nexowire_dispatch_runtime',password:'ci-only-not-a-production-credential',max:8,
    connectionTimeoutMillis:3000,idleTimeoutMillis:1000});
  const config:ConstructorParameters<typeof PostgresBrokerDispatchAuthority>[0]={
    pool:servicePool as DispatchStorePool,authorityId:ids.authorityId,privateKeyPem,
    verifyProvenance:async()=>({verified:provenance,authorityId:ids.authorityId,validUntil:Date.now()+30000}),
    readProtectedBroker:async()=>high?{...broker}:undefined,
    verifyOwnerRevocation:async()=>true,verifyNativeDrain:async()=>nativeDrain,...options};
  const create=(override:Partial<typeof config>={})=>new PostgresBrokerDispatchAuthority({...config,...override});
  const request=():BrokerDispatchRequest=>({requestId:randomUUID(),fingerprint:'c'.repeat(64),
    capability:'windows.service.control',scope:{ownerId:ids.ownerId,deviceId:ids.deviceId,
      deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,ownerEpoch:4,
      expectedGeneration:7,requiredPrivilege:'CORE'}});
  const revoke=()=>({deviceId:ids.deviceId,ownerId:ids.ownerId,deviceEpoch:ids.deviceEpoch,
    sessionEpoch:ids.sessionEpoch,expectedGeneration:7,signedOwnerApproval:'EXPLICIT_TEST_FIXTURE_NOT_OPERATOR_PROOF'.repeat(2)});
  return {pool,servicePool,ids,broker,config,create,request,revoke,authority:create(),
    setHigh:(v:boolean)=>{high=v},setProvenance:(v:boolean)=>{provenance=v},
    setNativeDrain:(v:boolean)=>{nativeDrain=v},close:async()=>{await servicePool.end();await pool.end();}};
}

test('protected PostgreSQL pool refuses missing TLS identities and URL overrides before connecting',()=>{
  assert.throws(()=>createProtectedPostgresDispatchPool({host:'pg.invalid',port:5432,
    database:'core',user:'service',password:'fixture',caPem:'',clientCertificatePem:'',clientKeyPem:''}),
    /DISPATCH_PG_PROTECTED_CONFIGURATION_REQUIRED/);
  assert.throws(()=>createProtectedPostgresDispatchPool({host:'pg.invalid?sslmode=disable',port:5432,
    database:'core',user:'service',password:'fixture',caPem:'-----BEGIN CERTIFICATE-----',
    clientCertificatePem:'-----BEGIN CERTIFICATE-----',clientKeyPem:'-----BEGIN PRIVATE KEY-----'}),
    /DISPATCH_PG_PROTECTED_CONFIGURATION_REQUIRED/);
});

test('external dispatch refuses absent provenance and never opens a database connection',async()=>{
  let connections=0;
  const authority=new PostgresBrokerDispatchAuthority({
    authorityId:randomUUID(),privateKeyPem,pool:{async connect(){connections++;throw Error('unavailable')}},
    verifyProvenance:async()=>{throw Error('independent authority unavailable')},
    readProtectedBroker:async()=>undefined,verifyOwnerRevocation:async()=>false,verifyNativeDrain:async()=>false});
  const req:BrokerDispatchRequest={requestId:randomUUID(),fingerprint:'c'.repeat(64),capability:'files.write',
    scope:{ownerId:randomUUID(),deviceId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
      ownerEpoch:1,expectedGeneration:1,requiredPrivilege:'CORE'}};
  const broker:ProtectedBrokerEvidence={verified:true,brokerId:randomUUID(),ownerEpoch:1,
    grantGeneration:1,highIntegrityToken:true,signedProtectedImage:true,protectedParentAndImports:true};
  await assert.rejects(authority.beginIfCurrent(req,broker,nonce()),denied('DISPATCH_STORE_PROVENANCE_UNAVAILABLE'));
  assert.equal(connections,0);
});

test('real PostgreSQL: signed reserve and commit are each one-use; release preserves global tombstone',integration,async()=>{
  const f=await fixture();try{
    const req=f.request(),reserved=decoded(await f.authority.beginIfCurrent(req,f.broker,nonce()));
    assert.equal(reserved.kind,'broker_dispatch_permit_v1');
    assert.equal(reserved.requestId,req.requestId);assert.equal(reserved.generation,7);
    const dispatchId=String(reserved.dispatchId);
    const committed=decoded(await f.authority.commitIfCurrent(req,f.broker,dispatchId,'b'.repeat(64)));
    assert.equal(committed.kind,'broker_dispatch_commit_v1');
    await assert.rejects(f.authority.commitIfCurrent(req,f.broker,dispatchId,'c'.repeat(64)),
      denied('DISPATCH_STORE_COMMIT_REPLAY_OR_SCOPE'));
    await f.authority.release({request:req,dispatchId,brokerId:f.ids.brokerId});
    await assert.rejects(f.create().beginIfCurrent(req,f.broker,nonce()),denied('DISPATCH_STORE_REQUEST_REPLAY'));
    const row=(await f.pool.query('SELECT state,sequence,commit_nonce FROM core_dispatch.claims WHERE request_id=$1',
      [req.requestId])).rows[0];
    assert.equal(row.state,'RELEASED');assert.equal(row.sequence,'1');assert.equal(row.commit_nonce,'b'.repeat(64));
  }finally{await f.close();}
});

test('real PostgreSQL: independent service instances racing the same UUID produce only one reservation',integration,async()=>{
  const f=await fixture();try{
    const req=f.request(),other=f.create();
    const results=await Promise.allSettled(Array.from({length:20},(_,i)=>
      (i%2?f.authority:other).beginIfCurrent(req,f.broker,nonce())));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected').length,19);
    const rows=await f.pool.query('SELECT COUNT(*) AS n FROM core_dispatch.claims WHERE request_id=$1',[req.requestId]);
    assert.equal(rows.rows[0].n,'1');
  }finally{await f.close();}
});

test('real PostgreSQL: lost begin COMMIT ACK remains terminal across a new service instance',integration,async()=>{
  const f=await fixture();try{
    let lost=false,destroyed=false;
    const pool:DispatchStorePool={async connect(){const client=await f.servicePool.connect();return {
      query:async(sql,values=[])=>{const result=await client.query(sql,values);
        if(sql==='COMMIT'&&!lost){lost=true;throw Error('TEST_LOST_ACK_AFTER_REAL_PG_COMMIT')}
        return {rows:result.rows as Record<string,unknown>[]};},
      release:(destroy=false)=>{destroyed||=destroy;client.release(destroy)},
    };}};
    const req=f.request();
    await assert.rejects(f.create({pool}).beginIfCurrent(req,f.broker,nonce()),
      denied('DISPATCH_STORE_TRANSACTION_UNKNOWN'));
    assert.equal(lost,true);assert.equal(destroyed,true);
    await assert.rejects(f.create().beginIfCurrent(req,f.broker,nonce()),denied('DISPATCH_STORE_REQUEST_REPLAY'));
    assert.equal((await f.pool.query('SELECT state FROM core_dispatch.claims WHERE request_id=$1',[req.requestId])).rows[0].state,
      'RESERVED');
  }finally{await f.close();}
});

test('real PostgreSQL: lost commit ACK never reaches the mutation callback and cannot replay',integration,async()=>{
  const f=await fixture();try{
    let commits=0,lost=false,callbacks=0;
    const pool:DispatchStorePool={async connect(){const client=await f.servicePool.connect();return {
      query:async(sql,values=[])=>{const result=await client.query(sql,values);
        if(sql==='COMMIT'&&++commits===2){lost=true;throw Error('TEST_COMMIT_ACK_LOST')}
        return {rows:result.rows as Record<string,unknown>[]};},release:(destroy=false)=>client.release(destroy),
    };}};
    const authority=f.create({pool});
    const fence=new BrokerExternalDispatchFence({authority,authorityId:f.ids.authorityId,publicKeyPem,
      verifyIdentity:async()=>true,verifyEffectiveBroker:async()=>({...f.broker}),verifyOwnerRevocation:async()=>true});
    const req=f.request();
    await assert.rejects(fence.execute(req,async()=>{callbacks++;}));
    assert.equal(lost,true);assert.equal(callbacks,0);
    await assert.rejects(f.create().beginIfCurrent(req,f.broker,nonce()),denied('DISPATCH_STORE_REQUEST_REPLAY'));
    assert.equal(callbacks,0);
  }finally{await f.close();}
});

test('real PostgreSQL: lost release ACK cannot replay an already completed callback',integration,async()=>{
  const f=await fixture();try{
    let commits=0,callbacks=0,lost=false;
    const pool:DispatchStorePool={async connect(){const client=await f.servicePool.connect();return {
      query:async(sql,values=[])=>{const result=await client.query(sql,values);
        if(sql==='COMMIT'&&++commits===3){lost=true;throw Error('TEST_RELEASE_ACK_LOST')}
        return {rows:result.rows as Record<string,unknown>[]};},release:(destroy=false)=>client.release(destroy),
    };}};
    const fence=new BrokerExternalDispatchFence({authority:f.create({pool}),authorityId:f.ids.authorityId,publicKeyPem,
      verifyIdentity:async()=>true,verifyEffectiveBroker:async()=>({...f.broker}),verifyOwnerRevocation:async()=>true});
    const req=f.request();
    // The callback's known return value is distinct from the release ACK.
    // Existing fence semantics retain that value but fence ALL later work.
    assert.equal(await fence.execute(req,async()=>++callbacks),1);
    assert.equal(lost,true);assert.equal(callbacks,1);
    await assert.rejects(fence.execute(req,async()=>++callbacks),denied('DISPATCH_REVOKE_PENDING'));
    await assert.rejects(fence.execute(f.request(),async()=>++callbacks),denied('DISPATCH_REVOKE_PENDING'));
    await assert.rejects(f.create().beginIfCurrent(req,f.broker,nonce()),denied('DISPATCH_STORE_REQUEST_REPLAY'));
    assert.equal(callbacks,1);
    assert.equal((await f.pool.query('SELECT state FROM core_dispatch.claims WHERE request_id=$1',[req.requestId])).rows[0].state,
      'RELEASED');
  }finally{await f.close();}
});

test('real PostgreSQL: expired reserve cannot commit or mint a replacement permit',integration,async()=>{
  const f=await fixture({permitMs:10});try{
    const req=f.request(),reserved=decoded(await f.authority.beginIfCurrent(req,f.broker,nonce()));
    await new Promise<void>(resolve=>setTimeout(resolve,25));
    await assert.rejects(f.authority.commitIfCurrent(req,f.broker,String(reserved.dispatchId),nonce()),
      denied('DISPATCH_STORE_RESERVATION_EXPIRED'));
    await assert.rejects(f.create().beginIfCurrent(req,f.broker,nonce()),denied('DISPATCH_STORE_REQUEST_REPLAY'));
  }finally{await f.close();}
});

test('real PostgreSQL: revoked reservation and stale HIGH cannot issue a commit receipt',integration,async()=>{
  const f=await fixture();try{
    const req=f.request(),reserved=decoded(await f.authority.beginIfCurrent(req,f.broker,nonce()));
    f.setHigh(false);
    await assert.rejects(f.authority.commitIfCurrent(req,f.broker,String(reserved.dispatchId),nonce()),
      denied('DISPATCH_STORE_BROKER_UNVERIFIED'));
    f.setHigh(true);
    const proof=decoded(await f.authority.revokeAndDrain(f.revoke(),nonce()));
    assert.equal(proof.drained,true);assert.equal(proof.generation,8);
    await assert.rejects(f.authority.commitIfCurrent(req,f.broker,String(reserved.dispatchId),nonce()),
      denied('DISPATCH_STORE_GRANT_REVOKED'));
    await assert.rejects(f.authority.beginIfCurrent(f.request(),f.broker,nonce()),
      denied('DISPATCH_STORE_GRANT_REVOKED'));
  }finally{await f.close();}
});

test('real PostgreSQL + HTTPS: actual fence, client and server preserve one-use admission and stale-HIGH denial',integration,async()=>{
  const f=await fixture();
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-real-pg-dispatch-'));
  const previous=tls.getCACertificates('default');
  const keyFile=path.join(root,'fixture.key'),certFile=path.join(root,'fixture.crt');
  let server:ReturnType<typeof createServer>|undefined;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-sha256','-nodes',
      '-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost',
      '-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'],
      {stdio:'ignore',timeout:15000});
    tls.setDefaultCACertificates([...previous,await readFile(certFile,'utf8')]);
    const token=randomUUID()+randomUUID();
    const principal={brokerId:f.ids.brokerId,ownerId:f.ids.ownerId,deviceId:f.ids.deviceId,
      deviceEpoch:f.ids.deviceEpoch,sessionEpoch:f.ids.sessionEpoch};
    const handler=createBrokerDispatchAuthorityHandler({authorityId:f.ids.authorityId,publicKeyPem,
      authority:f.authority,authenticateBroker:async credential=>credential===token?principal:undefined,
      readProtectedBroker:async()=>({...f.broker}),verifyOwnerRevocation:async()=>true});
    server=createServer({key:await readFile(keyFile),cert:await readFile(certFile)},handler);
    await new Promise<void>(resolve=>server!.listen(0,'localhost',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const remote=new HttpsBrokerDispatchAuthority({endpoint:'https://localhost:'+address.port+'/v1/broker-dispatch',
      brokerCredential:async()=>token});
    let high=true,callbacks=0;
    const fence=()=>new BrokerExternalDispatchFence({authority:remote,authorityId:f.ids.authorityId,publicKeyPem,
      verifyIdentity:async()=>true,verifyEffectiveBroker:async()=>({...f.broker,highIntegrityToken:high as true}),
      verifyOwnerRevocation:async()=>true});
    const original=f.request();
    assert.equal(await fence().execute(original,async()=>++callbacks),1);
    await assert.rejects(fence().execute(original,async()=>++callbacks));
    const commit=f.authority.commitIfCurrent.bind(f.authority);
    f.authority.commitIfCurrent=async(...args)=>{const result=await commit(...args);high=false;return result;};
    const stale=f.request();
    await assert.rejects(fence().execute(stale,async()=>++callbacks),denied('DISPATCH_HIGH_TOKEN_UNVERIFIED'));
    assert.equal(callbacks,1,'only the original authorized fixture callback may have run');
    const rows=await f.pool.query('SELECT state FROM core_dispatch.claims WHERE request_id=ANY($1::uuid[])',
      [[original.requestId,stale.requestId]]);
    assert.equal(rows.rows.length,2);assert.ok(rows.rows.every(row=>row.state==='RELEASED'));
  }finally{
    server?.closeAllConnections();
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    tls.setDefaultCACertificates(previous);await f.close();await rm(root,{recursive:true,force:true});
  }
});

test('real PostgreSQL: revoke persists fence while committed work is unresolved; drain timeout is UNKNOWN',integration,async()=>{
  const f=await fixture({drainTimeoutMs:25});try{
    const req=f.request(),reserved=decoded(await f.authority.beginIfCurrent(req,f.broker,nonce()));
    const dispatchId=String(reserved.dispatchId);
    await f.authority.commitIfCurrent(req,f.broker,dispatchId,nonce());
    await assert.rejects(f.authority.revokeAndDrain(f.revoke(),nonce()),denied('DISPATCH_STORE_DRAIN_UNKNOWN'));
    const row=(await f.pool.query('SELECT state,generation,core_enabled FROM core_dispatch.grants '+
      'WHERE authority_id=$1 AND device_id=$2',[f.ids.authorityId,f.ids.deviceId])).rows[0];
    assert.equal(row.state,'REVOKING');assert.equal(row.generation,'8');assert.equal(row.core_enabled,false);
    await assert.rejects(f.create().beginIfCurrent(f.request(),f.broker,nonce()),denied('DISPATCH_STORE_GRANT_REVOKED'));
    await f.authority.release({request:req,dispatchId,brokerId:f.ids.brokerId});
    await assert.rejects(f.authority.revokeAndDrain(f.revoke(),nonce()),denied('DISPATCH_STORE_REVOKE_STALE'));
    await assert.rejects(f.create().beginIfCurrent(req,f.broker,nonce()),denied('DISPATCH_STORE_GRANT_REVOKED'));
  }finally{await f.close();}
});

test('real PostgreSQL: empty ledger is not physical drain evidence',integration,async()=>{
  const f=await fixture({drainTimeoutMs:0});try{
    f.setNativeDrain(false);
    await assert.rejects(f.authority.revokeAndDrain(f.revoke(),nonce()),denied('DISPATCH_STORE_DRAIN_UNKNOWN'));
    assert.equal((await f.pool.query('SELECT state FROM core_dispatch.grants WHERE authority_id=$1 AND device_id=$2',
      [f.ids.authorityId,f.ids.deviceId])).rows[0].state,'REVOKING');
  }finally{await f.close();}
});

test('real PostgreSQL: cross-owner release and historical tombstone rewrite are rejected',integration,async()=>{
  const f=await fixture();try{
    const req=f.request(),reserved=decoded(await f.authority.beginIfCurrent(req,f.broker,nonce()));
    const dispatchId=String(reserved.dispatchId);
    const wrong={...req,scope:{...req.scope,ownerId:randomUUID()}};
    await assert.rejects(f.authority.release({request:wrong,dispatchId,brokerId:f.ids.brokerId}),
      denied('DISPATCH_STORE_RELEASE_SCOPE_OR_REPLAY'));
    await assert.rejects(f.pool.query("UPDATE core_dispatch.claims SET request='{}'::jsonb WHERE request_id=$1",[req.requestId]),
      /CORE_DISPATCH_HISTORY_REWRITE_DENIED/);
    await assert.rejects(f.pool.query('DELETE FROM core_dispatch.claims WHERE request_id=$1',[req.requestId]),
      /CORE_DISPATCH_HISTORY_DELETE_DENIED/);
    await assert.rejects(f.servicePool.query('TRUNCATE core_dispatch.claims'),/permission denied/i);
    await assert.rejects(f.servicePool.query('DELETE FROM core_dispatch.claims WHERE request_id=$1',[req.requestId]),
      /permission denied/i);
    await f.authority.release({request:req,dispatchId,brokerId:f.ids.brokerId});
    await assert.rejects(f.authority.beginIfCurrent(req,f.broker,nonce()),denied('DISPATCH_STORE_REQUEST_REPLAY'));
  }finally{await f.close();}
});

test('real PostgreSQL: service refuses a superuser or history-owning database role',integration,async()=>{
  const f=await fixture();try{
    await assert.rejects(f.create({pool:f.pool}).beginIfCurrent(f.request(),f.broker,nonce()),
      denied('DISPATCH_STORE_ROLE_OVERPRIVILEGED'));
  }finally{await f.close();}
});

test('real PostgreSQL: ROOT expiry caps both signed admissions and clock rewind denies execution',integration,async()=>{
  const f=await fixture();try{
    const expires=Date.now()+1000;
    await f.pool.query('UPDATE core_dispatch.grants SET root_expires_ms=$3 WHERE authority_id=$1 AND device_id=$2',
      [f.ids.authorityId,f.ids.deviceId,expires]);
    const req=f.request();req.scope.requiredPrivilege='ROOT';
    const reserved=decoded(await f.authority.beginIfCurrent(req,f.broker,nonce()));
    assert.equal(reserved.expiresAtMs,expires);
    const committed=decoded(await f.authority.commitIfCurrent(req,f.broker,String(reserved.dispatchId),nonce()));
    assert.equal(committed.expiresAtMs,expires);
    await f.pool.query('UPDATE core_dispatch.authorities SET max_seen_ms=$2 WHERE authority_id=$1',
      [f.ids.authorityId,Date.now()+60000]);
    await assert.rejects(f.authority.beginIfCurrent(f.request(),f.broker,nonce()),denied('DISPATCH_STORE_CLOCK_REWIND'));
  }finally{await f.close();}
});

test('real PostgreSQL restart: historical UUID remains terminal after an actual server restart',{
  skip:!enabled||!restartPhase?'ACTUAL_POSTGRES_RESTART_NOT_REQUESTED; production NOT_PROVEN':false,
  timeout:30000,
},async()=>{
  assert.ok(restartPhase==='seed'||restartPhase==='verify');
  const stateFile=path.join(os.tmpdir(),'nexowire-dispatch-ci-restart-state.json');
  const f=await fixture();
  try{
    if(restartPhase==='seed'){
      const req=f.request(),reserved=decoded(await f.authority.beginIfCurrent(req,f.broker,nonce()));
      await f.authority.commitIfCurrent(req,f.broker,String(reserved.dispatchId),nonce());
      await f.authority.release({request:req,dispatchId:String(reserved.dispatchId),brokerId:f.ids.brokerId});
      const start=(await f.pool.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started as Date;
      await writeFile(stateFile,JSON.stringify({authorityId:f.ids.authorityId,request:req,
        broker:f.broker,postmasterStartedAt:start.toISOString()}),{flag:'wx',mode:0o600});
      return;
    }
    const contents=await readFile(stateFile,'utf8');assert.ok(contents.length<16384);
    const previous=JSON.parse(contents) as {authorityId:string;request:BrokerDispatchRequest;
      broker:ProtectedBrokerEvidence;postmasterStartedAt:string};
    assert.match(previous.authorityId,/^[0-9a-f-]{36}$/);
    const start=(await f.pool.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started as Date;
    assert.ok(start.getTime()>Date.parse(previous.postmasterStartedAt),'the database server itself must have restarted');
    const authority=f.create({authorityId:previous.authorityId,
      verifyProvenance:async()=>({verified:true,authorityId:previous.authorityId,validUntil:Date.now()+30000}),
      readProtectedBroker:async()=>({...previous.broker})});
    await assert.rejects(authority.beginIfCurrent(previous.request,previous.broker,nonce()),
      denied('DISPATCH_STORE_REQUEST_REPLAY'));
    const row=(await f.pool.query('SELECT state FROM core_dispatch.claims WHERE request_id=$1',
      [previous.request.requestId])).rows[0];
    assert.equal(row.state,'RELEASED');
  }finally{await f.close();}
});
