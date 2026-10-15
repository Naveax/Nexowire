import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  type D1DatabaseLike,type D1PreparedStatementLike,type D1ResultLike,
  D1ControlPlaneStore,
} from '../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {McpOAuthService,McpOAuthError} from '../src/product/mcp-oauth.js';
import {ProposedMcpOAuthAccountLogout} from '../src/product/mcp-oauth-account-logout-proposal.js';
class Statement implements D1PreparedStatementLike {
  constructor(private readonly statement:StatementSync,private readonly values:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Statement(this.statement,args)}
  async first<T>():Promise<T|null>{
    return (this.statement.get(...this.values as Parameters<StatementSync['get']>)??null) as T|null;
  }
  async all<T>():Promise<D1ResultLike<T>>{
    return {success:true,results:this.statement.all(...this.values as Parameters<StatementSync['all']>) as T[]};
  }
  async run<T>():Promise<D1ResultLike<T>>{
    return {success:true,meta:{changes:Number(this.statement.run(...this.values as Parameters<StatementSync['run']>).changes)}};
  }
}
class Adapter implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Statement(this.db.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN');
    try{const result=[];for(const item of items)result.push(await item.run());this.db.exec('COMMIT');return result}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
}
const at=new Date('2026-10-15T12:00:00.000Z');
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
async function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const f of ['0001_control_plane.sql','0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql','0005_mcp_oauth.sql']){
    db.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',f),'utf8'));
  }
  db.exec(readFileSync(path.join(process.cwd(),'test/fixtures/scale-v2-s1-oauth-logout-staging.sql'),'utf8'));
  const adapter=new Adapter(db);
  const control=new ControlPlaneService(new D1ControlPlaneStore(adapter),{now:()=>at});
  await control.ensureAccount({id:'logout-owner-001'});
  await control.ensureAccount({id:'unaffected-owner-002'});
  db.prepare('INSERT INTO mcp_oauth_clients(client_id,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES(?,?,?,?)')
    .run('session-client-001','[]','none','2026-10-01T00:00:00.000Z');
  const seed=(accountId:string,suffix:string)=>{
    const access='nwx_mcp_'+suffix;
    const refresh='nwx_refresh_'+suffix;
    const code='nwx_code_'+suffix;
    const attrs=['session-client-001',accountId,'https://mcp.example.test/mcp','["mcp","offline_access"]',
      '2026-10-16T00:00:00.000Z','2026-10-14T00:00:00.000Z'] as const;
    db.prepare('INSERT INTO mcp_oauth_access_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(hash(access),...attrs);
    db.prepare('INSERT INTO mcp_oauth_refresh_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(hash(refresh),attrs[0],attrs[1],attrs[2],attrs[3],attrs[4],null,attrs[5]);
    db.prepare('INSERT INTO mcp_oauth_codes(code_hash,client_id,account_id,redirect_uri,code_challenge,resource,scopes_json,expires_at,consumed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(hash(code),attrs[0],attrs[1],'https://chatgpt.com/oauth/callback/test','challenge',
        attrs[2],attrs[3],attrs[4],null,attrs[5]);
    return {access,refresh,code};
  };
  const logout=new ProposedMcpOAuthAccountLogout(adapter);
  return {db,adapter,logout,seed,close(){db.close()}};
}
function record(db:DatabaseSync,table:string,token:string):Record<string,unknown>{
 return db.prepare('SELECT * FROM '+table+' WHERE token_hash=?').get(hash(token)) as Record<string,unknown>;
}
test('one staged logout expires owner access, revokes every refresh and closes pending auth codes',async()=>{
 const f=await fixture();try{
  const a=f.seed('logout-owner-001','session-a'),b=f.seed('logout-owner-001','session-b'),
    other=f.seed('unaffected-owner-002','session-other');
  assert.equal(await f.logout.revokeAuthenticated({authenticatedAccountId:'logout-owner-001',
    targetAccountId:'logout-owner-001',logoutId:'logout-request-0001',at}),'revoked');
  for(const x of [a,b]){
    assert.equal(record(f.db,'mcp_oauth_access_tokens',x.access).expires_at,at.toISOString());
    assert.equal(record(f.db,'mcp_oauth_refresh_tokens',x.refresh).revoked_at,at.toISOString());
    const code=f.db.prepare('SELECT consumed_at FROM mcp_oauth_codes WHERE code_hash=?')
      .get(hash(x.code)) as {consumed_at:string};
    assert.equal(code.consumed_at,at.toISOString());
  }
  assert.equal(record(f.db,'mcp_oauth_refresh_tokens',other.refresh).revoked_at,null);
  assert.equal(record(f.db,'mcp_oauth_access_tokens',other.access).expires_at,
    '2026-10-16T00:00:00.000Z');
 }finally{f.close()}
});
test('cross-owner logout is rejected without altering sessions',async()=>{
 const f=await fixture();try{
  const t=f.seed('unaffected-owner-002','victim-a');
  assert.equal(await f.logout.revokeAuthenticated({authenticatedAccountId:'logout-owner-001',
    targetAccountId:'unaffected-owner-002',logoutId:'forbidden-0001',at}),'denied');
  assert.equal(record(f.db,'mcp_oauth_refresh_tokens',t.refresh).revoked_at,null);
 }finally{f.close()}
});
test('replay logout does not generate multiple mutation grants',async()=>{
 const f=await fixture();try{
  const input={authenticatedAccountId:'logout-owner-001',targetAccountId:'logout-owner-001',
    logoutId:'logout-repeat-0002',at};
  const statuses=await Promise.all(Array.from({length:12},()=>f.logout.revokeAuthenticated(input)));
  assert.equal(statuses.filter(x=>x==='revoked').length,1);
  assert.equal(statuses.filter(x=>x==='already-revoked').length,11);
  const total=(f.db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_account_logout_gate').get() as {n:number}).n;
  assert.equal(total,1);
 }finally{f.close()}
});
test('late access, refresh and authorization code inserts are refused after logout',async()=>{
 const f=await fixture();try{
  const s=f.seed('logout-owner-001','before-race');
  await f.logout.revokeAuthenticated({authenticatedAccountId:'logout-owner-001',
    targetAccountId:'logout-owner-001',logoutId:'logout-race-0003',at});
  assert.throws(()=>f.seed('logout-owner-001','after-race'),/oauth_account_logout_locked/);
  const other=f.seed('unaffected-owner-002','after-other');
  assert.ok(other.refresh);
  assert.equal(record(f.db,'mcp_oauth_refresh_tokens',s.refresh).revoked_at,at.toISOString());
 }finally{f.close()}
});
test('refresh grant is invalid after account logout, not just access token invalidation',async()=>{
 const f=await fixture();try{
  const s=f.seed('logout-owner-001','refresh-session');
  await f.logout.revokeAuthenticated({authenticatedAccountId:'logout-owner-001',
    targetAccountId:'logout-owner-001',logoutId:'logout-refreshtest-0004',at});
  const {D1McpOAuthStore}=await import('../src/product/d1-mcp-oauth-store.js');
  const oauth=new McpOAuthService(new D1McpOAuthStore(f.adapter),{
    issuer:'https://auth.example.test',resource:'https://mcp.example.test/mcp',now:()=>at,
  });
  assert.equal(await oauth.authenticateAccessToken(s.access),null);
  await assert.rejects(oauth.token(new URLSearchParams({
    grant_type:'refresh_token',refresh_token:s.refresh,client_id:'session-client-001',
    resource:'https://mcp.example.test/mcp',
  })),(err:unknown)=>err instanceof McpOAuthError && err.code==='invalid_grant');
 }finally{f.close()}
});
test('unknown DB outage and invalid caller identity cannot authorize logout',async()=>{
 const down:D1DatabaseLike={prepare(){throw new Error('D1_UNAVAILABLE')},
  async batch(){throw new Error('D1_UNAVAILABLE')}};
 const obj=new ProposedMcpOAuthAccountLogout(down);
 await assert.rejects(obj.revokeAuthenticated({authenticatedAccountId:'logout-owner-001',
   targetAccountId:'logout-owner-001',logoutId:'outage-request-0005',at}),/D1_UNAVAILABLE/);
 await assert.rejects(obj.revokeAuthenticated({authenticatedAccountId:'',targetAccountId:'',
   logoutId:'bad',at}),/Invalid trusted OAuth logout input/);
});
test('revocation remains account-locked; legitimate new login requires future reviewed session-epoch design',async()=>{
 const f=await fixture();try{
  await f.logout.revokeAuthenticated({authenticatedAccountId:'logout-owner-001',
    targetAccountId:'logout-owner-001',logoutId:'logout-permanent-0006',at});
  assert.throws(()=>f.db.prepare('INSERT INTO mcp_oauth_codes(code_hash,client_id,account_id,redirect_uri,code_challenge,resource,scopes_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('after-login','session-client-001','logout-owner-001','https://chatgpt.com/oauth/callback/test','challenge',
      'https://mcp.example.test/mcp','["mcp"]','2026-10-16T00:00:00Z','2026-10-15T13:00:00Z'),
    /oauth_account_logout_locked/);
 }finally{f.close()}
});
