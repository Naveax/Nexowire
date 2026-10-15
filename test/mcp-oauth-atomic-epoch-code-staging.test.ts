import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  D1ControlPlaneStore,type D1DatabaseLike,type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {D1McpOAuthStore} from '../src/product/d1-mcp-oauth-store.js';
import {McpOAuthService} from '../src/product/mcp-oauth.js';
import {ProposedMcpOAuthSessionEpoch} from '../src/product/mcp-oauth-session-epoch-proposal.js';
import {ProposedMcpOAuthEpochAtomicCode} from '../src/product/mcp-oauth-atomic-epoch-code-proposal.js';
class Statement implements D1PreparedStatementLike {
  constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Statement(this.stmt,args)}
  async first<T>():Promise<T|null>{return (this.stmt.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null}
  async all<T>():Promise<D1ResultLike<T>>{return {success:true,results:this.stmt.all(...this.args as Parameters<StatementSync['all']>) as T[]}}
  async run<T>():Promise<D1ResultLike<T>>{return {success:true,meta:{changes:Number(this.stmt.run(...this.args as Parameters<StatementSync['run']>).changes)}}}
}
class DB implements D1DatabaseLike {
  constructor(readonly sqlite:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Statement(this.sqlite.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.sqlite.exec('BEGIN');
    try{const out=[];for(const item of items)out.push(await item.run());this.sqlite.exec('COMMIT');return out}
    catch(e){this.sqlite.exec('ROLLBACK');throw e}
  }
}
const clock=new Date('2026-10-15T14:00:00.000Z');
const account='code-owner-0001',other='code-owner-0002';
const client='code-client-0001';
const resource='https://mcp.example.test/mcp';
const redirect='https://chatgpt.com/oauth/callback/atomic-test';
const verifier='v'.repeat(43);
const challenge=(s:string)=>createHash('sha256').update(s).digest('base64url');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const token=(label:string)=>'nwx_code_'+label.repeat(44);
async function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for(const name of [
    '0001_control_plane.sql','0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
    '0005_mcp_oauth.sql'
  ]) sqlite.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',name),'utf8'));
  const db=new DB(sqlite);
  const control=new ControlPlaneService(new D1ControlPlaneStore(db),{now:()=>clock});
  await control.ensureAccount({id:account});
  await control.ensureAccount({id:other});
  sqlite.prepare('INSERT INTO mcp_oauth_clients (client_id,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES (?,?,?,?)')
    .run(client,'[]','none','2026-10-14T00:00:00.000Z');
  for(const name of [
    'scale-v2-s1-oauth-logout-staging.sql',
    'scale-v2-s1-oauth-session-epoch-staging.sql',
    'scale-v2-s1-oauth-atomic-code-staging.sql',
  ]) sqlite.exec(readFileSync(path.join(process.cwd(),'test/fixtures',name),'utf8'));
  const lifecycle=new ProposedMcpOAuthSessionEpoch({
    db,verifyCurrentOwner:async()=>true,
    verifyFreshFirstPartyLogin:async()=>true,now:()=>clock,
  });
  const activate=async()=>{
    const l=await lifecycle.transition({authenticatedAccountId:account,
      targetAccountId:account,kind:'logout',operationId:'first-logout-code-001'});
    assert.equal(l.status,'transitioned');
    const a=await lifecycle.transition({authenticatedAccountId:account,
      targetAccountId:account,kind:'reauth',operationId:'first-reauth-code-001'});
    assert.equal(a.status,'transitioned');
  };
  const seed=(s:string,options:{
    owner?:string;scope?:string;epoch?:number;expires?:string;
    uri?:string;pkce?:string;
  }={})=>{
    sqlite.prepare(
      'INSERT INTO mcp_oauth_codes (code_hash,client_id,account_id,redirect_uri,code_challenge,resource,scopes_json,expires_at,consumed_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(hash(s),client,options.owner??account,options.uri??redirect,
      options.pkce??challenge(verifier),resource,
      options.scope??'["mcp","offline_access"]',
      options.expires??'2026-10-15T14:04:00.000Z',
      null,'2026-10-15T13:59:00.000Z',options.epoch??2);
    return s;
  };
  const api=new ProposedMcpOAuthEpochAtomicCode({db,resource,now:()=>clock});
  const oauth=new McpOAuthService(new D1McpOAuthStore(db),{
    issuer:'https://auth.example.test',resource,now:()=>clock,
  });
  const exchange=(code:string,overrides:Partial<{
    codeVerifier:string;clientId:string;redirectUri:string;requestedResource:string;
  }>={})=>api.exchange({code,codeVerifier:verifier,clientId:client,
    redirectUri:redirect,requestedResource:resource,...overrides});
  const readCode=(s:string)=>sqlite.prepare(
    'SELECT consumed_at FROM mcp_oauth_codes WHERE code_hash=?'
  ).get(hash(s)) as {consumed_at:string|null};
  const count=(table:string)=>(sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get() as {n:number}).n;
  return {db,sqlite,activate,seed,api,oauth,exchange,readCode,count,lifecycle,
    close(){sqlite.close()}};
}

test('valid PKCE code atomically mints usable access and offline refresh',async()=>{
  const f=await fixture();try{
    await f.activate();const code=f.seed(token('A'));
    const minted=await f.exchange(code);
    assert.equal(minted.token_type,'Bearer');
    assert.equal(minted.expires_in,3600);
    assert.equal(minted.scope,'mcp offline_access');
    assert.match(minted.access_token,/^nwx_mcp_/);
    assert.match(minted.refresh_token??'',/^nwx_refresh_/);
    assert.equal(f.readCode(code).consumed_at,clock.toISOString());
    assert.ok(await f.oauth.authenticateAccessToken(minted.access_token));
    assert.equal(f.count('mcp_oauth_epoch_code_redemptions'),1);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),1);
    const row=f.sqlite.prepare('SELECT session_epoch FROM mcp_oauth_access_tokens WHERE token_hash=?')
      .get(hash(minted.access_token)) as {session_epoch:number};
    assert.equal(row.session_epoch,2);
  }finally{f.close()}
});

test('MCP-only code mints access without unwanted refresh credential',async()=>{
  const f=await fixture();try{
    await f.activate();
    const code=f.seed(token('B'),{scope:'["mcp"]'});
    const minted=await f.exchange(code);
    assert.equal(minted.refresh_token,undefined);
    assert.equal(minted.scope,'mcp');
    assert.equal(f.count('mcp_oauth_refresh_tokens'),0);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
  }finally{f.close()}
});

test('code replay is refused and cannot create another token pair',async()=>{
  const f=await fixture();try{
    await f.activate();const code=f.seed(token('C'));
    await f.exchange(code);
    await assert.rejects(f.exchange(code),/credential unavailable/);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),1);
  }finally{f.close()}
});

test('16 concurrent same-code attempts accept at most one redemption',async()=>{
  const f=await fixture();try{
    await f.activate();const code=f.seed(token('D'));
    const rs=await Promise.allSettled(Array.from({length:16},()=>f.exchange(code)));
    assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(rs.filter(r=>r.status==='rejected').length,15);
    assert.equal(f.count('mcp_oauth_epoch_code_redemptions'),1);
    assert.equal(f.count('mcp_oauth_access_tokens'),1);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),1);
  }finally{f.close()}
});

test('wrong verifier, client, callback redirect and resource leave code untouched',async()=>{
  const f=await fixture();try{
    await f.activate();const code=f.seed(token('E'));
    for(const args of [
      {codeVerifier:'z'.repeat(43)},
      {clientId:'wrong-client'},
      {redirectUri:'https://evil.example/callback'},
      {requestedResource:'https://evil.example/mcp'},
    ])await assert.rejects(f.exchange(code,args));
    assert.equal(f.readCode(code).consumed_at,null);
    assert.equal(f.count('mcp_oauth_epoch_code_redemptions'),0);
    assert.equal(f.count('mcp_oauth_access_tokens'),0);
  }finally{f.close()}
});

test('expired or locked epoch code cannot mint after account logout',async()=>{
  const f=await fixture();try{
    await f.activate();
    const expired=f.seed(token('F'),{expires:'2026-10-15T13:00:00.000Z'});
    await assert.rejects(f.exchange(expired),/credential unavailable/);
    const code=f.seed(token('G'));
    const transition=await f.lifecycle.transition({authenticatedAccountId:account,
      targetAccountId:account,kind:'logout',operationId:'second-logout-code-002'});
    assert.equal(transition.status,'transitioned');
    await assert.rejects(f.exchange(code),/credential unavailable/);
    assert.equal(f.count('mcp_oauth_epoch_code_redemptions'),0);
  }finally{f.close()}
});

test('inconsistent token hash collision rolls back authorization-code consumption',async()=>{
  const f=await fixture();try{
    await f.activate();const code=f.seed(token('H'));
    const oldHash=hash('existing-access-code-collision');
    f.sqlite.prepare(
      'INSERT INTO mcp_oauth_access_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at,session_epoch) VALUES(?,?,?,?,?,?,?,?)'
    ).run(oldHash,client,account,resource,'["mcp","offline_access"]',
      '2026-10-16T00:00:00.000Z',clock.toISOString(),2);
    const sql='INSERT INTO mcp_oauth_epoch_code_redemptions '+
      '(operation_id,code_hash,account_id,client_id,redirect_uri,code_challenge,resource,scopes_json,session_epoch,redeemed_at,new_access_hash,access_expires_at,new_refresh_hash,refresh_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    assert.throws(()=>f.sqlite.prepare(sql).run(
      'code-collision-operation-001',hash(code),account,client,redirect,
      challenge(verifier),resource,'["mcp","offline_access"]',
      2,clock.toISOString(),oldHash,
      '2026-10-15T15:00:00.000Z',hash('new-refresh-code-hash'),
      '2026-11-14T14:00:00.000Z'),/UNIQUE|constraint/i);
    assert.equal(f.readCode(code).consumed_at,null);
    assert.equal(f.count('mcp_oauth_epoch_code_redemptions'),0);
    assert.equal(f.count('mcp_oauth_refresh_tokens'),0);
  }finally{f.close()}
});

test('no authenticated epoch state means legacy code exchange fails closed',async()=>{
  const f=await fixture();try{
    const code=f.seed(token('I'),{epoch:0});
    await assert.rejects(f.exchange(code),/session epoch unavailable/);
    assert.equal(f.readCode(code).consumed_at,null);
  }finally{f.close()}
});

test('lost provider response after commit never returns an unacknowledged token',async()=>{
  const f=await fixture();try{
    await f.activate();const code=f.seed(token('J'));
    let committed=false;
    const wrapped:D1DatabaseLike={
      prepare(sql:string){
        const stmt=f.db.prepare(sql);
        if(!sql.startsWith('INSERT INTO mcp_oauth_epoch_code_redemptions'))return stmt;
        return {
          bind(...args:unknown[]){
            const bound=stmt.bind(...args);
            return {
              bind(...more:unknown[]){return bound.bind(...more)},
              first<T>(){return bound.first<T>()},
              all<T>(){return bound.all<T>()},
              async run<T>():Promise<D1ResultLike<T>>{
                await bound.run<T>();committed=true;
                return {success:true,meta:{changes:0}};
              },
            };
          },
          first<T>(){return stmt.first<T>()},
          all<T>(){return stmt.all<T>()},
          run<T>(){return stmt.run<T>()},
        };
      },
      batch(items){return f.db.batch(items)},
    };
    const api=new ProposedMcpOAuthEpochAtomicCode({db:wrapped,resource,now:()=>clock});
    await assert.rejects(api.exchange({code,clientId:client,redirectUri:redirect,
      codeVerifier:verifier,requestedResource:resource}),/not acknowledged/);
    assert.equal(committed,true);
    assert.equal(f.readCode(code).consumed_at,clock.toISOString());
    assert.equal(f.count('mcp_oauth_epoch_code_redemptions'),1);
    await assert.rejects(f.exchange(code),/credential unavailable/);
  }finally{f.close()}
});
