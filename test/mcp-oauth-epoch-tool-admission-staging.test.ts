import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  D1ControlPlaneStore, type D1DatabaseLike,
  type D1PreparedStatementLike, type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { ProposedMcpOAuthSessionEpoch } from '../src/product/mcp-oauth-session-epoch-proposal.js';
import { ProposedMcpOAuthEpochToolAdmission } from '../src/product/mcp-oauth-epoch-tool-admission-proposal.js';

class Stmt implements D1PreparedStatementLike {
  constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Stmt(this.stmt,args)}
  async first<T>():Promise<T|null>{return (this.stmt.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null}
  async all<T>():Promise<D1ResultLike<T>>{return {success:true,results:this.stmt.all(...this.args as Parameters<StatementSync['all']>) as T[]}}
  async run<T>():Promise<D1ResultLike<T>>{return {success:true,meta:{changes:Number(this.stmt.run(...this.args as Parameters<StatementSync['run']>).changes)}}}
}
class DB implements D1DatabaseLike {
  constructor(readonly sqlite:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Stmt(this.sqlite.prepare(sql))}
  async batch(xs:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.sqlite.exec('BEGIN');
    try{const a=[];for(const x of xs)a.push(await x.run());this.sqlite.exec('COMMIT');return a}
    catch(e){this.sqlite.exec('ROLLBACK');throw e}
  }
}
const clock=new Date('2026-10-15T14:30:00.000Z');
const owner='tool-owner-001',other='tool-other-002';
const device='tool-device-001';
const secondDevice='tool-device-002';
const client='tool-client-001';
const resource='https://mcp.example.test/mcp';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

async function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for(const file of [
    '0001_control_plane.sql','0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
    '0005_mcp_oauth.sql','0009_device_access_mode.sql',
  ]) sqlite.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',file),'utf8'));
  const db=new DB(sqlite);
  const control=new ControlPlaneService(new D1ControlPlaneStore(db),{now:()=>clock});
  await control.ensureAccount({id:owner});
  await control.ensureAccount({id:other});
  sqlite.prepare(
    'INSERT INTO mcp_oauth_clients(client_id,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES (?,?,?,?)',
  ).run(client,'[]','none','2026-10-14T00:00:00Z');
  for(const file of [
    'scale-v2-s1-oauth-logout-staging.sql',
    'scale-v2-s1-oauth-session-epoch-staging.sql',
  ]) sqlite.exec(readFileSync(path.join(process.cwd(),'test/fixtures',file),'utf8'));

  const setDevice=(id:string,account:string,access_mode='safe',online=1)=>{
    sqlite.prepare(
      'INSERT INTO devices(id,owner_account_id,name,platform,credential_hash,online,created_at,updated_at,access_mode) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id,account,'Test device','windows','test-credential-'+id,
      online,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z',access_mode);
  };
  setDevice(device,owner,'safe',1);
  setDevice(secondDevice,other,'full',1);
  const createToken=(account:string,epoch:number,label:string,opts:{
    scopes?:string;resource?:string;expires?:string;
  }={})=>{
    const raw='nwx_mcp_'+label;
    sqlite.prepare(
      'INSERT INTO mcp_oauth_access_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?)',
    ).run(hash(raw),client,account,opts.resource??resource,
      opts.scopes??'["mcp","offline_access"]',
      opts.expires??'2026-10-16T14:30:00Z','2026-10-14T14:30:00Z',epoch);
    return raw;
  };
  const token=createToken(owner,0,'admission-legacy-001');
  const otherToken=createToken(other,0,'admission-other-002');
  const epoch=new ProposedMcpOAuthSessionEpoch({
    db,verifyCurrentOwner:async()=>true,
    verifyFreshFirstPartyLogin:async()=>true,now:()=>clock,
  });
  const gate=new ProposedMcpOAuthEpochToolAdmission({db,resource,now:()=>clock});
  const transition=(kind:'logout'|'reauth',id:string)=>
    epoch.transition({kind,operationId:id,
      targetAccountId:owner,authenticatedAccountId:owner});
  const check=(options:Partial<{
    rawAccessToken:string;deviceId:string;kind:'read'|'write';
  }>={})=>gate.check({rawAccessToken:token,deviceId:device,kind:'read',...options});
  return {sqlite,db,gate,token,otherToken,createToken,setDevice,transition,check,
    close(){sqlite.close()}};
}

test('owner online safe-mode device accepts read but never write',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await f.check(),{
      accountId:owner,clientId:client,deviceId:device,sessionEpoch:0,accessMode:'safe',
    });
    assert.equal(await f.check({kind:'write'}),null);
    f.sqlite.prepare('UPDATE devices SET access_mode=? WHERE id=?').run('full',device);
    assert.equal((await f.check({kind:'write'}))?.accessMode,'full');
  }finally{f.close()}
});

test('cross-account target device is denied for every action kind',async()=>{
  const f=await fixture();try{
    assert.equal(await f.check({deviceId:secondDevice}),null);
    assert.equal(await f.check({deviceId:secondDevice,kind:'write'}),null);
    assert.equal((await f.check({rawAccessToken:f.otherToken,deviceId:secondDevice,kind:'write'}))?.accountId,other);
  }finally{f.close()}
});

test('offline or nonexistent device is denied even for read',async()=>{
  const f=await fixture();try{
    f.sqlite.prepare('UPDATE devices SET online=0 WHERE id=?').run(device);
    assert.equal(await f.check(),null);
    assert.equal(await f.check({deviceId:'nonexistent-device'}),null);
  }finally{f.close()}
});

test('logout invalidates token access even if stale expires_at is restored',async()=>{
  const f=await fixture();try{
    await f.transition('logout','tool-logout-0001');
    f.sqlite.prepare('UPDATE mcp_oauth_access_tokens SET expires_at=? WHERE token_hash=?')
      .run('2026-10-16T14:30:00Z',hash(f.token));
    assert.equal(await f.check(),null);
    await f.transition('reauth','tool-reauth-0001');
    assert.equal(await f.check(),null);
    const current=f.createToken(owner,2,'current-tool-token-2');
    assert.equal((await f.check({rawAccessToken:current}))?.sessionEpoch,2);
  }finally{f.close()}
});

test('a missing current epoch row cannot resurrect historically revoked owner',async()=>{
  const f=await fixture();try{
    await f.transition('logout','tool-logout-0002');
    f.sqlite.prepare('DELETE FROM mcp_oauth_session_epochs WHERE account_id=?').run(owner);
    f.sqlite.prepare('UPDATE mcp_oauth_access_tokens SET expires_at=? WHERE token_hash=?')
      .run('2026-10-16T14:30:00Z',hash(f.token));
    assert.equal(await f.check(),null);
    assert.equal((await f.check({rawAccessToken:f.otherToken,deviceId:secondDevice}))?.accountId,other);
  }finally{f.close()}
});

test('mutating dispatch refuses logout between initial admission and execution',async()=>{
  const f=await fixture();try{
    f.sqlite.prepare('UPDATE devices SET access_mode=? WHERE id=?').run('full',device);
    let invoked=false;
    await assert.rejects(f.gate.dispatch({
      rawAccessToken:f.token,deviceId:device,kind:'write',
    },async()=>{invoked=true;return true},async()=>{
      await f.transition('logout','tool-logout-midflight');
    }),/admission changed/);
    assert.equal(invoked,false);
  }finally{f.close()}
});

test('mutating dispatch refuses owner transfer between its two reads',async()=>{
  const f=await fixture();try{
    f.sqlite.prepare('UPDATE devices SET access_mode=? WHERE id=?').run('full',device);
    let invoked=false;
    await assert.rejects(f.gate.dispatch({
      rawAccessToken:f.token,deviceId:device,kind:'write',
    },async()=>{invoked=true;return true},async()=>{
      f.sqlite.prepare('UPDATE devices SET owner_account_id=? WHERE id=?').run(other,device);
    }),/admission changed/);
    assert.equal(invoked,false);
  }finally{f.close()}
});

test('mutating dispatch rejects access-mode downgrade before handler runs',async()=>{
  const f=await fixture();try{
    f.sqlite.prepare('UPDATE devices SET access_mode=? WHERE id=?').run('full',device);
    let invoked=false;
    await assert.rejects(f.gate.dispatch({
      rawAccessToken:f.token,deviceId:device,kind:'write',
    },async()=>{invoked=true;return true},async()=>{
      f.sqlite.prepare('UPDATE devices SET access_mode=? WHERE id=?').run('safe',device);
    }),/admission changed/);
    assert.equal(invoked,false);
  }finally{f.close()}
});

test('uninterrupted authorized request reaches handler once',async()=>{
  const f=await fixture();try{
    let invoked=0;
    const result=await f.gate.dispatch({
      rawAccessToken:f.token,deviceId:device,kind:'read',
    },async grant=>{invoked++;return grant.accountId});
    assert.equal(result,owner);
    assert.equal(invoked,1);
  }finally{f.close()}
});

test('wrong resource/scope, expired credential, malformed operation are rejected',async()=>{
  const f=await fixture();try{
    const wrongResource=f.createToken(owner,0,'invalid-resource',{
      resource:'https://elsewhere.test/mcp'});
    const wrongScope=f.createToken(owner,0,'invalid-scope',{
      scopes:'["offline_access"]'});
    const expired=f.createToken(owner,0,'expired-token',{
      expires:'2026-10-14T00:00:00Z'});
    assert.equal(await f.check({rawAccessToken:wrongResource}),null);
    assert.equal(await f.check({rawAccessToken:wrongScope}),null);
    assert.equal(await f.check({rawAccessToken:expired}),null);
    assert.equal(await f.check({rawAccessToken:'not-a-token'}),null);
    assert.equal(await f.gate.check({
      rawAccessToken:f.token,deviceId:device,kind:'admin' as 'read',
    }),null);
  }finally{f.close()}
});

test('D1 read outage denies the dispatch and never starts handler',async()=>{
  const failing:D1DatabaseLike={
    prepare(){throw new Error('D1_READ_UNAVAILABLE')},
    async batch(){throw new Error('D1_READ_UNAVAILABLE')},
  };
  const gate=new ProposedMcpOAuthEpochToolAdmission({db:failing,resource,now:()=>clock});
  let invoked=false;
  await assert.rejects(gate.dispatch({
    rawAccessToken:'nwx_mcp_credential-xyz',deviceId:device,kind:'write',
  },async()=>{invoked=true}),/D1_READ_UNAVAILABLE/);
  assert.equal(invoked,false);
});
