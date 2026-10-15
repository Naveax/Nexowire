import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  D1ControlPlaneStore, type D1DatabaseLike, type D1PreparedStatementLike,
  type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { ProposedMcpOAuthAccountLogout } from '../src/product/mcp-oauth-account-logout-proposal.js';
import { ProposedMcpOAuthSessionEpoch } from '../src/product/mcp-oauth-session-epoch-proposal.js';
import { D1McpOAuthStore } from '../src/product/d1-mcp-oauth-store.js';
import { McpOAuthService } from '../src/product/mcp-oauth.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly statement: StatementSync,
    private readonly args: unknown[] = []) {}
  bind(...args: unknown[]): D1PreparedStatementLike {
    return new Statement(this.statement, args);
  }
  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args as Parameters<StatementSync['get']>) ?? null) as T | null;
  }
  async all<T>(): Promise<D1ResultLike<T>> {
    return {success: true, results: this.statement.all(
      ...this.args as Parameters<StatementSync['all']>) as T[]};
  }
  async run<T>(): Promise<D1ResultLike<T>> {
    return {success:true,meta:{changes:Number(this.statement.run(
      ...this.args as Parameters<StatementSync['run']>).changes)}};
  }
}
class DB implements D1DatabaseLike {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string): D1PreparedStatementLike {
    return new Statement(this.db.prepare(sql));
  }
  async batch(stmts: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const stmt of stmts) results.push(await stmt.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
const clock = new Date('2026-10-15T13:00:00.000Z');
const owner = 'epoch-owner-0001';
const other = 'epoch-other-0002';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const migrationFiles = [
  '0001_control_plane.sql', '0002_external_identities.sql',
  '0003_quota_subject_device_anchor.sql', '0004_device_credential_lookup.sql',
  '0005_mcp_oauth.sql',
];
async function fixture(options: { legacyLocked?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of migrationFiles) sqlite.exec(readFileSync(
    path.join(process.cwd(),'cloudflare/migrations',name),'utf8'));
  sqlite.exec(readFileSync(path.join(
    process.cwd(),'test/fixtures/scale-v2-s1-oauth-logout-staging.sql'),'utf8'));
  const db = new DB(sqlite);
  const control = new ControlPlaneService(new D1ControlPlaneStore(db), { now: () => clock });
  await control.ensureAccount({id: owner});
  await control.ensureAccount({id: other});
  sqlite.prepare(
    'INSERT INTO mcp_oauth_clients (client_id,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES (?,?,?,?)',
  ).run('epoch-client-0001','[]','none','2026-10-14T00:00:00.000Z');

  if (options.legacyLocked === true) {
    const legacy = new ProposedMcpOAuthAccountLogout(db);
    assert.equal(await legacy.revokeAuthenticated({
      authenticatedAccountId:owner,targetAccountId:owner,
      logoutId:'old-lock-event-0001',at:clock,
    }), 'revoked');
  }

  sqlite.exec(readFileSync(path.join(
    process.cwd(),'test/fixtures/scale-v2-s1-oauth-session-epoch-staging.sql'),'utf8'));
  let ownerPermission = true;
  let loginPermission = true;
  const lifecycle = new ProposedMcpOAuthSessionEpoch({
    db,
    verifyCurrentOwner:async()=>ownerPermission,
    verifyFreshFirstPartyLogin:async()=>loginPermission,
    now:()=>clock,
  });
  const legacyTokenIssuer = new McpOAuthService(new D1McpOAuthStore(db), {
    issuer:'https://auth.example.test',
    resource:'https://mcp.example.test/mcp',
    now:()=>clock,
  });
  const issue = (accountId:string, epoch:number, suffix:string) => {
    const access='nwx_mcp_'+suffix;
    const refresh='nwx_refresh_'+suffix;
    const code='nwx_code_'+suffix;
    const common=[
      'epoch-client-0001',accountId,'https://mcp.example.test/mcp',
      '["mcp","offline_access"]','2026-10-16T13:00:00.000Z',
    ] as const;
    sqlite.prepare(
      'INSERT INTO mcp_oauth_access_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?)',
    ).run(sha(access),...common,'2026-10-14T00:00:00.000Z',epoch);
    sqlite.prepare(
      'INSERT INTO mcp_oauth_refresh_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,revoked_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(sha(refresh),...common,null,'2026-10-14T00:00:00.000Z',epoch);
    sqlite.prepare(
      'INSERT INTO mcp_oauth_codes(code_hash,client_id,account_id,redirect_uri,code_challenge,resource,scopes_json,expires_at,consumed_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(sha(code),common[0],common[1],'https://chatgpt.com/oauth/callback/test',
      'unused-challenge',common[2],common[3],common[4],null,
      '2026-10-14T00:00:00.000Z',epoch);
    return {access,refresh,code};
  };
  const row = (table:string,token:string) => sqlite.prepare(
    'SELECT * FROM '+table+' WHERE token_hash = ?',
  ).get(sha(token)) as Record<string, unknown>;
  const go = (kind:'logout'|'reauth',operationId:string,
    accountId=owner,authenticatedAccountId=accountId) =>
      lifecycle.transition({kind,operationId,targetAccountId:accountId,authenticatedAccountId});
  return {sqlite,db,lifecycle,legacyTokenIssuer,issue,row,go,
    setOwnerPermission(v:boolean){ownerPermission=v},
    setLoginPermission(v:boolean){loginPermission=v},
    close(){sqlite.close()}};
}

test('new epoch begins at 0, logout expires all owner tokens and leaves other owner valid',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(await f.lifecycle.state(owner),{generation:0,locked:false});
    const a=f.issue(owner,0,'owner-a'), b=f.issue(owner,0,'owner-b'),
      foreign=f.issue(other,0,'foreign');
    const result=await f.go('logout','epoch-logout-0001');
    assert.deepEqual(result,{status:'transitioned',state:{generation:1,locked:true}});
    for(const token of [a,b]){
      assert.equal(f.row('mcp_oauth_access_tokens',token.access).expires_at,clock.toISOString());
      assert.equal(f.row('mcp_oauth_refresh_tokens',token.refresh).revoked_at,clock.toISOString());
      assert.equal((f.sqlite.prepare('SELECT consumed_at FROM mcp_oauth_codes WHERE code_hash=?')
        .get(sha(token.code)) as {consumed_at:string}).consumed_at,clock.toISOString());
      assert.equal(await f.legacyTokenIssuer.authenticateAccessToken(token.access),null);
    }
    assert.equal(f.row('mcp_oauth_refresh_tokens',foreign.refresh).revoked_at,null);
    assert.equal(f.row('mcp_oauth_access_tokens',foreign.access).session_epoch,0);
  }finally{f.close()}
});

test('fresh first-party reauthentication advances epoch, then permits only current generation issuance',async()=>{
  const f=await fixture();
  try{
    f.issue(owner,0,'pre-login');
    assert.equal((await f.go('logout','epoch-logout-0002')).status,'transitioned');
    assert.throws(()=>f.issue(owner,0,'stale-during-lock'),/oauth_access_session_epoch_denied/);
    assert.equal((await f.go('reauth','epoch-reauth-0002')).status,'transitioned');
    assert.deepEqual(await f.lifecycle.state(owner),{generation:2,locked:false});
    assert.throws(()=>f.issue(owner,0,'stale-after-login'),/oauth_access_session_epoch_denied/);
    assert.throws(()=>f.issue(owner,1,'stale-prior-locked'),/oauth_access_session_epoch_denied/);
    const current=f.issue(owner,2,'current-generation');
    assert.ok(await f.legacyTokenIssuer.authenticateAccessToken(current.access));
    assert.equal(f.row('mcp_oauth_refresh_tokens',current.refresh).revoked_at,null);
  }finally{f.close()}
});

test('repeated logout->fresh reauth->logout again invalidates all newer tokens too',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.go('logout','epoch-logout-0003')).status,'transitioned');
    assert.equal((await f.go('reauth','epoch-reauth-0003')).status,'transitioned');
    const newToken=f.issue(owner,2,'cycle-two');
    assert.equal((await f.go('logout','epoch-logout-0004')).status,'transitioned');
    assert.deepEqual(await f.lifecycle.state(owner),{generation:3,locked:true});
    assert.equal(await f.legacyTokenIssuer.authenticateAccessToken(newToken.access),null);
    assert.equal(f.row('mcp_oauth_refresh_tokens',newToken.refresh).revoked_at,clock.toISOString());
    assert.throws(()=>f.issue(owner,2,'late-cycle-two'),/oauth_access_session_epoch_denied/);
    assert.equal((await f.go('reauth','epoch-reauth-0004')).status,'transitioned');
    assert.deepEqual(await f.lifecycle.state(owner),{generation:4,locked:false});
    assert.throws(()=>f.issue(owner,2,'old-epoch-no-replay'),/oauth_access_session_epoch_denied/);
    f.issue(owner,4,'generation-four');
  }finally{f.close()}
});

test('fresh reauth cannot be authorized through an old access-token session callback',async()=>{
  const f=await fixture();
  try{
    await f.go('logout','epoch-logout-0005');
    f.setLoginPermission(false);
    assert.deepEqual(await f.go('reauth','epoch-reauth-denied-0005'),{status:'denied'});
    assert.deepEqual(await f.lifecycle.state(owner),{generation:1,locked:true});
    f.setLoginPermission(true);
    assert.equal((await f.go('reauth','epoch-reauth-allowed-0005')).status,'transitioned');
  }finally{f.close()}
});

test('cross-account caller cannot log out or reauthorize an unrelated owner',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(await f.go('logout','epoch-cross-account-0006',owner,other),{status:'denied'});
    assert.deepEqual(await f.lifecycle.state(owner),{generation:0,locked:false});
    f.setOwnerPermission(false);
    assert.deepEqual(await f.go('logout','epoch-owner-denied-0006'),{status:'denied'});
    assert.deepEqual(await f.lifecycle.state(owner),{generation:0,locked:false});
  }finally{f.close()}
});

test('concurrent same-ID transition admits exactly once, no increment on replay',async()=>{
  const f=await fixture();
  try{
    const r=await Promise.all(Array.from({length:12},
      ()=>f.go('logout','epoch-parallel-0007')));
    assert.equal(r.filter(x=>x.status==='transitioned').length,1);
    assert.equal(r.filter(x=>x.status==='duplicate').length,11);
    assert.deepEqual(await f.lifecycle.state(owner),{generation:1,locked:true});
    assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_session_epoch_events')
      .get() as {n:number}).n,1);
  }finally{f.close()}
});

test('competing distinct reauth transitions reject stale epoch rather than unlock twice',async()=>{
  const f=await fixture();
  try{
    await f.go('logout','epoch-logout-0008');
    const results=await Promise.allSettled([
      f.go('reauth','epoch-reauth-first-0008'),
      f.go('reauth','epoch-reauth-second-0008'),
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled' &&
      x.value.status==='transitioned').length,1);
    const refused=results.filter(x=>x.status==='rejected' ||
      (x.status==='fulfilled' && x.value.status==='denied'));
    assert.equal(refused.length,1);
    for(const result of refused) {
      if(result.status==='rejected')assert.match(String(result.reason),
        /oauth_session_epoch_stale_or_locked/);
    }
    assert.deepEqual(await f.lifecycle.state(owner),{generation:2,locked:false});
  }finally{f.close()}
});

test('old hard-lock gate is backfilled locked, never reopened before fresh verification',async()=>{
  const f=await fixture({legacyLocked:true});
  try{
    assert.deepEqual(await f.lifecycle.state(owner),{generation:1,locked:true});
    assert.throws(()=>f.issue(owner,0,'old-lock-replay'),/oauth_access_session_epoch_denied/);
    assert.deepEqual(await f.go('logout','old-lock-logout-again'),{status:'denied'});
    f.setLoginPermission(false);
    assert.deepEqual(await f.go('reauth','old-lock-denied'),{status:'denied'});
    f.setLoginPermission(true);
    assert.equal((await f.go('reauth','old-lock-fresh')).status,'transitioned');
    f.issue(owner,2,'valid-after-old-lock');
  }finally{f.close()}
});

test('reusing a global operation ID for another kind/account never changes state',async()=>{
  const f=await fixture();
  try{
    await f.go('logout','epoch-id-collision-0009');
    await assert.rejects(f.go('reauth','epoch-id-collision-0009'),/collision/);
    await assert.rejects(f.go('logout','epoch-id-collision-0009',other),/collision/);
    assert.deepEqual(await f.lifecycle.state(owner),{generation:1,locked:true});
    assert.deepEqual(await f.lifecycle.state(other),{generation:0,locked:false});
  }finally{f.close()}
});

test('legacy OAuth issuer without epoch integration fails closed after first logout',async()=>{
  const f=await fixture();
  try{
    await f.go('logout','epoch-logout-0010');
    await f.go('reauth','epoch-reauth-0010');
    const token = 'nwx_mcp_legacy-issuer-epoch-zero';
    assert.throws(()=>{
      f.sqlite.prepare(
        'INSERT INTO mcp_oauth_access_tokens (token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(sha(token),'epoch-client-0001',owner,'https://mcp.example.test/mcp',
        '["mcp"]','2026-10-16T00:00:00Z',clock.toISOString());
    },/oauth_access_session_epoch_denied/);
    assert.equal(await f.legacyTokenIssuer.authenticateAccessToken(token),null);
  }finally{f.close()}
});

test('old refresh remains invalid even after a later successful owner login',async()=>{
  const f=await fixture();
  try{
    const prior=f.issue(owner,0,'stale-refresh-old');
    await f.go('logout','epoch-logout-refresh-0011');
    await f.go('reauth','epoch-reauth-refresh-0011');
    await assert.rejects(f.legacyTokenIssuer.token(new URLSearchParams({
      grant_type:'refresh_token',refresh_token:prior.refresh,
      client_id:'epoch-client-0001',resource:'https://mcp.example.test/mcp',
    })),(err:unknown)=>err instanceof Error &&
      err.message.includes('Refresh token is invalid or expired'));
    assert.equal(f.row('mcp_oauth_refresh_tokens',prior.refresh).revoked_at,clock.toISOString());
  }finally{f.close()}
});

test('stale refresh and auth-code insertion are both SQL denied after reauth',async()=>{
  const f=await fixture();
  try{
    await f.go('logout','epoch-logout-stale-0012');
    await f.go('reauth','epoch-reauth-stale-0012');
    assert.throws(()=>f.sqlite.prepare(
      'INSERT INTO mcp_oauth_refresh_tokens (token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?)',
    ).run('stale-refresh-hash','epoch-client-0001',owner,
      'https://mcp.example.test/mcp','["mcp"]',
      '2026-10-16T13:00:00Z',clock.toISOString(),0),
    /oauth_refresh_session_epoch_denied/);
    assert.throws(()=>f.sqlite.prepare(
      'INSERT INTO mcp_oauth_codes (code_hash,client_id,account_id,redirect_uri,code_challenge,resource,scopes_json,expires_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('stale-code-hash','epoch-client-0001',owner,
      'https://chatgpt.com/oauth/callback/test','challenge','https://mcp.example.test/mcp',
      '["mcp"]','2026-10-16T13:00:00Z',clock.toISOString(),0),
    /oauth_code_session_epoch_denied/);
    const counts = [
      'mcp_oauth_refresh_tokens','mcp_oauth_codes',
    ].map(table=>(f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table)
      .get() as {n:number}).n);
    assert.deepEqual(counts,[0,0]);
  }finally{f.close()}
});

test('unacknowledged provider / invalid epoch data cannot grant lifecycle transition',async()=>{
  const down:D1DatabaseLike={prepare(){throw new Error('D1_UNAVAILABLE')},
    async batch(){throw new Error('D1_UNAVAILABLE')}};
  const l=new ProposedMcpOAuthSessionEpoch({db:down,
    verifyCurrentOwner:async()=>true,
    verifyFreshFirstPartyLogin:async()=>true,now:()=>clock});
  await assert.rejects(l.transition({authenticatedAccountId:owner,targetAccountId:owner,
    kind:'logout',operationId:'epoch-outage-0011'}),/D1_UNAVAILABLE/);
  await assert.rejects(l.transition({authenticatedAccountId:owner,targetAccountId:owner,
    kind:'logout',operationId:'bad'}),/Invalid trusted session epoch input/);
});
