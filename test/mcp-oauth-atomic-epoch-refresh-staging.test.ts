import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type D1DatabaseLike,type D1PreparedStatementLike,type D1ResultLike,
  D1ControlPlaneStore,
} from '../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {D1McpOAuthStore} from '../src/product/d1-mcp-oauth-store.js';
import {McpOAuthService} from '../src/product/mcp-oauth.js';
import {ProposedMcpOAuthSessionEpoch} from '../src/product/mcp-oauth-session-epoch-proposal.js';
import {ProposedMcpOAuthEpochAtomicRefresh} from '../src/product/mcp-oauth-atomic-epoch-refresh-proposal.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Statement(this.stmt,args)}
  async first<T>():Promise<T|null>{return (this.stmt.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null}
  async all<T>():Promise<D1ResultLike<T>>{return {success:true,results:this.stmt.all(...this.args as Parameters<StatementSync['all']>) as T[]}}
  async run<T>():Promise<D1ResultLike<T>>{return {success:true,meta:{changes:Number(this.stmt.run(...this.args as Parameters<StatementSync['run']>).changes)}}}
}
class Adapter implements D1DatabaseLike {
  constructor(readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Statement(this.db.prepare(sql))}
  async batch(xs:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN');
    try{const results=[];for(const x of xs)results.push(await x.run());this.db.exec('COMMIT');return results}
    catch(e){this.db.exec('ROLLBACK');throw e}
  }
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const at=new Date('2026-10-15T13:00:00.000Z');
const accountId='rotate-owner-0001';
const otherId='rotate-other-0002';
const clientId='epoch-rotation-client-0001';
const resource='https://mcp.example.test/mcp';
const scope='["mcp","offline_access"]';
const refresh=(suffix:string)=>'nwx_refresh_'+suffix.repeat(44);
async function fixture(){
  const directory=mkdtempSync(path.join(os.tmpdir(),'nwx-oauth-atomic-refresh-'));
  const filename=path.join(directory,'refresh.sqlite');
  const sqlite=new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  for(const file of ['0001_control_plane.sql','0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql','0005_mcp_oauth.sql']){
    sqlite.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',file),'utf8'));
  }
  const db=new Adapter(sqlite);
  const svc=new ControlPlaneService(new D1ControlPlaneStore(db),{now:()=>at});
  await svc.ensureAccount({id:accountId});
  await svc.ensureAccount({id:otherId});
  sqlite.prepare('INSERT INTO mcp_oauth_clients(client_id,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES(?,?,?,?)')
    .run(clientId,'[]','none','2026-10-14T00:00:00.000Z');
  for(const file of ['scale-v2-s1-oauth-logout-staging.sql',
    'scale-v2-s1-oauth-session-epoch-staging.sql',
    'scale-v2-s1-oauth-atomic-refresh-staging.sql']){
    sqlite.exec(readFileSync(path.join(process.cwd(),'test/fixtures',file),'utf8'));
  }
  const epoch=new ProposedMcpOAuthSessionEpoch({
    db,verifyCurrentOwner:async()=>true,
    verifyFreshFirstPartyLogin:async()=>true,now:()=>at,
  });
  const start=async()=>{
    const logout=await epoch.transition({authenticatedAccountId:accountId,
      targetAccountId:accountId,operationId:'rotation-logout-0001',kind:'logout'});
    assert.equal(logout.status,'transitioned');
    const reauth=await epoch.transition({authenticatedAccountId:accountId,
      targetAccountId:accountId,operationId:'rotation-reauth-0001',kind:'reauth'});
    assert.equal(reauth.status,'transitioned');
  };
  const seed=(token:string,owner=accountId,generation=2)=>{
    sqlite.prepare('INSERT INTO mcp_oauth_refresh_tokens (token_hash,client_id,account_id,resource,scopes_json,expires_at,revoked_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(hash(token),clientId,owner,resource,scope,'2026-10-16T00:00:00.000Z',
        null,'2026-10-15T12:00:00.000Z',generation);
  };
  const concurrentSqlite=new DatabaseSync(filename);
  concurrentSqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const concurrentDb=new Adapter(concurrentSqlite);
  const api=new ProposedMcpOAuthEpochAtomicRefresh({db,resource,now:()=>at});
  const oauth=new McpOAuthService(new D1McpOAuthStore(db),{
    issuer:'https://auth.example.test',resource,now:()=>at,
  });
  const rotate=(token:string,client=clientId,url=resource)=>api.rotate({
    refreshToken:token,clientId:client,requestedResource:url,
  });
  const row=(token:string)=>sqlite.prepare(
    'SELECT * FROM mcp_oauth_refresh_tokens WHERE token_hash=?',
  ).get(hash(token)) as Record<string,unknown>|undefined;
  const count=(table:string)=>(sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get() as {n:number}).n;
  return {db,concurrentDb,sqlite,epoch,api,oauth,start,seed,rotate,row,count,
    close(){concurrentSqlite.close();sqlite.close();rmSync(directory,{recursive:true,force:true})}};
}

test('one atomic rotation issues usable access+refresh at current trusted epoch',async()=>{
  const f=await fixture();try{
    await f.start();
    const token=refresh('A');f.seed(token);
    const issued=await f.rotate(token);
    assert.equal(issued.token_type,'Bearer');
    assert.equal(issued.expires_in,3600);
    assert.equal(issued.scope,'mcp offline_access');
    assert.match(issued.access_token,/^nwx_mcp_/);
    assert.match(issued.refresh_token,/^nwx_refresh_/);
    assert.equal(f.row(token)?.revoked_at,at.toISOString());
    assert.equal(f.row(issued.refresh_token)?.session_epoch,2);
    assert.ok(await f.oauth.authenticateAccessToken(issued.access_token));
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),1);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),2);
  }finally{f.close()}
});

test('refresh replay is rejected even if first response is still valid',async()=>{
  const f=await fixture();try{
    await f.start();const token=refresh('B');f.seed(token);
    await f.rotate(token);
    await assert.rejects(f.rotate(token),/OAuth refresh credential unavailable/);
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),1);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
  }finally{f.close()}
});

test('16 simultaneous identical refresh requests mint exactly one pair',async()=>{
  const f=await fixture();try{
    await f.start();const token=refresh('C');f.seed(token);
    const responses=await Promise.allSettled(Array.from({length:16},()=>f.rotate(token)));
    assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(responses.filter(r=>r.status==='rejected').length,15);
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),1);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),2);
  }finally{f.close()}
});

test('two independent file-backed SQLite connections admit one atomic refresh only',async()=>{
  const f=await fixture();try{
    await f.start();
    const token=refresh('J');f.seed(token);
    const second=new ProposedMcpOAuthEpochAtomicRefresh({
      db:f.concurrentDb,resource,now:()=>at,
    });
    const decisions=await Promise.allSettled([
      f.rotate(token),
      second.rotate({refreshToken:token,clientId,requestedResource:resource}),
    ]);
    assert.equal(decisions.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(decisions.filter(x=>x.status==='rejected').length,1);
    assert.equal(f.row(token)?.revoked_at,at.toISOString());
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),1);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),2);
  }finally{f.close()}
});

test('wrong OAuth client/resource and foreign credential cannot mint tokens',async()=>{
  const f=await fixture();try{
    await f.start();
    const token=refresh('D');f.seed(token);
    await assert.rejects(f.rotate(token,'another-client'),/unavailable/);
    await assert.rejects(f.rotate(token,clientId,'https://wrong.example/mcp'),/Invalid OAuth refresh grant/);
    assert.equal(f.row(token)?.revoked_at,null);
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),0);
    assert.equal(f.count('mcp_oauth_access_tokens'),0);
  }finally{f.close()}
});

test('logout races with rotation: revoked old credential cannot mint in locked epoch',async()=>{
  const f=await fixture();try{
    await f.start();const token=refresh('E');f.seed(token);
    await f.epoch.transition({authenticatedAccountId:accountId,targetAccountId:accountId,
      kind:'logout',operationId:'rotation-later-logout'});
    await assert.rejects(f.rotate(token),/OAuth refresh credential unavailable/);
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),0);
    assert.equal(f.count('mcp_oauth_access_tokens'),0);
  }finally{f.close()}
});

test('new-generation rotation cannot revive an old-generation credential',async()=>{
  const f=await fixture();try{
    await f.start();const old=refresh('F');f.seed(old);
    await f.epoch.transition({authenticatedAccountId:accountId,targetAccountId:accountId,
      kind:'logout',operationId:'rotation-second-logout'});
    await f.epoch.transition({authenticatedAccountId:accountId,targetAccountId:accountId,
      kind:'reauth',operationId:'rotation-second-login'});
    await assert.rejects(f.rotate(old),/OAuth refresh credential unavailable/);
    const fresh=refresh('G');f.seed(fresh,accountId,4);
    const output=await f.rotate(fresh);
    assert.equal(f.row(output.refresh_token)?.session_epoch,4);
  }finally{f.close()}
});

test('new access hash collision rolls back old refresh consumption and all records',async()=>{
  const f=await fixture();try{
    await f.start();const prior=refresh('H');f.seed(prior);
    const collisionHash=hash('preexisting-access');
    f.sqlite.prepare('INSERT INTO mcp_oauth_access_tokens (token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?)')
      .run(collisionHash,clientId,accountId,resource,scope,
        '2026-10-16T00:00:00.000Z',at.toISOString(),2);
    const before=f.count('mcp_oauth_refresh_tokens');
    const sql='INSERT INTO mcp_oauth_epoch_refresh_rotations (operation_id,old_refresh_hash,account_id,client_id,resource,scopes_json,session_epoch,rotated_at,new_access_hash,new_refresh_hash,access_expires_at,refresh_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
    assert.throws(()=>f.sqlite.prepare(sql).run(
      'colliding-operation-0001',hash(prior),accountId,clientId,resource,
      scope,2,at.toISOString(),collisionHash,hash('fresh-new-refresh'),
      '2026-10-15T14:00:00.000Z','2026-11-14T13:00:00.000Z',
    ),/UNIQUE|constraint/i);
    assert.equal(f.row(prior)?.revoked_at,null);
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),0);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),before);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
  }finally{f.close()}
});

test('provider missing acknowledgement is never accepted as rotation success',async()=>{
  const f=await fixture();try{
    await f.start();const old=refresh('I');f.seed(old);
    let wrote=false;
    const wrapped:D1DatabaseLike={
      prepare(sql:string){
        const statement=f.db.prepare(sql);
        if(!sql.startsWith('INSERT INTO mcp_oauth_epoch_refresh_rotations'))return statement;
        return {
          bind(...values:unknown[]){
            const bound=statement.bind(...values);
            return {
              bind(...other:unknown[]){return bound.bind(...other)},
              first<T>(){return bound.first<T>()},
              all<T>(){return bound.all<T>()},
              async run<T>():Promise<D1ResultLike<T>>{
                await bound.run<T>();wrote=true;
                return {success:true,meta:{changes:0}};
              },
            };
          },
          first<T>(){return statement.first<T>()},
          all<T>(){return statement.all<T>()},
          run<T>(){return statement.run<T>()},
        };
      },
      batch(items){return f.db.batch(items)},
    };
    const service=new ProposedMcpOAuthEpochAtomicRefresh({db:wrapped,resource,now:()=>at});
    await assert.rejects(service.rotate({refreshToken:old,clientId,
      requestedResource:resource}),/not acknowledged/);
    assert.equal(wrote,true);
    assert.equal(f.row(old)?.revoked_at,at.toISOString());
    assert.equal(f.count('mcp_oauth_epoch_refresh_rotations'),1);
    await assert.rejects(f.rotate(old),/unavailable/);
  }finally{f.close()}
});
