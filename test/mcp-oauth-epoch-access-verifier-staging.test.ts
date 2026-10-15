import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  D1DatabaseLike, D1PreparedStatementLike, D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import { D1ControlPlaneStore } from '../src/product/d1-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { ProposedMcpOAuthSessionEpoch } from '../src/product/mcp-oauth-session-epoch-proposal.js';
import { ProposedMcpOAuthEpochAccessVerifier } from '../src/product/mcp-oauth-epoch-access-verifier-proposal.js';
import { ProposedMcpOAuthEpochAtomicRefresh } from '../src/product/mcp-oauth-atomic-epoch-refresh-proposal.js';
import { D1McpOAuthStore } from '../src/product/d1-mcp-oauth-store.js';
import { McpOAuthService } from '../src/product/mcp-oauth.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly statement: StatementSync, private readonly args: unknown[] = []) {}
  bind(...args: unknown[]): D1PreparedStatementLike { return new Statement(this.statement,args); }
  async first<T>(): Promise<T|null> {
    return (this.statement.get(...this.args as Parameters<StatementSync['get']>) ?? null) as T|null;
  }
  async all<T>(): Promise<D1ResultLike<T>> {
    return { success: true, results: this.statement.all(
      ...this.args as Parameters<StatementSync['all']>) as T[] };
  }
  async run<T>(): Promise<D1ResultLike<T>> {
    return { success: true, meta: { changes: Number(this.statement.run(
      ...this.args as Parameters<StatementSync['run']>).changes) } };
  }
}
class DB implements D1DatabaseLike {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): D1PreparedStatementLike { return new Statement(this.database.prepare(sql)); }
  async batch(items: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    this.database.exec('BEGIN');
    try {
      const all = [];
      for (const item of items) all.push(await item.run());
      this.database.exec('COMMIT');
      return all;
    } catch(e) {
      this.database.exec('ROLLBACK');
      throw e;
    }
  }
}
const clock = new Date('2026-10-15T12:00:00.000Z');
const resource = 'https://mcp.example.test/mcp';
const owner = 'verify-account-0001';
const second = 'verify-account-0002';
const client = 'verify-client-0001';
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const migrations = ['0001_control_plane.sql','0002_external_identities.sql',
  '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
  '0005_mcp_oauth.sql'];
async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const m of migrations) sqlite.exec(readFileSync(
    path.join(process.cwd(),'cloudflare/migrations',m),'utf8'));
  const db = new DB(sqlite);
  const control = new ControlPlaneService(new D1ControlPlaneStore(db),{now:()=>clock});
  await control.ensureAccount({id:owner});
  await control.ensureAccount({id:second});
  sqlite.prepare(
    'INSERT INTO mcp_oauth_clients(client_id,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES(?,?,?,?)'
  ).run(client,'[]','none','2026-10-01T00:00:00.000Z');
  for (const fixtureName of ['scale-v2-s1-oauth-logout-staging.sql',
    'scale-v2-s1-oauth-session-epoch-staging.sql',
    'scale-v2-s1-oauth-atomic-refresh-staging.sql']) {
    sqlite.exec(readFileSync(path.join(process.cwd(),'test/fixtures',fixtureName),'utf8'));
  }
  const lifecycle = new ProposedMcpOAuthSessionEpoch({
    db,verifyCurrentOwner:async()=>true,verifyFreshFirstPartyLogin:async()=>true,now:()=>clock,
  });
  const verifier = new ProposedMcpOAuthEpochAccessVerifier({db,resource,now:()=>clock});
  const legacy = new McpOAuthService(new D1McpOAuthStore(db),{
    issuer:'https://auth.example.test',resource,now:()=>clock,
  });
  const seed = (account:string,epoch:number,label:string,options:{
    scopes?:string;resource?:string;created?:string;expires?:string;
  }={})=>{
    const token='nwx_mcp_'+label;
    sqlite.prepare(
      'INSERT INTO mcp_oauth_access_tokens (token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?)',
    ).run(hash(token),client,account,options.resource??resource,
      options.scopes??'["mcp","offline_access"]',
      options.expires??'2026-10-16T12:00:00.000Z',
      options.created??'2026-10-14T12:00:00.000Z',epoch);
    return token;
  };
  const transition = (kind:'logout'|'reauth',label:string,account=owner)=>
    lifecycle.transition({authenticatedAccountId:account,targetAccountId:account,
      operationId:'epoch-verify-'+label,kind});
  return {db,sqlite,seed,transition,verifier,lifecycle,legacy,
    close(){sqlite.close()}};
}

test('legacy generation-zero token is accepted only before any account transition',async()=>{
  const f=await fixture();try {
    const token=f.seed(owner,0,'legacy-before-transition');
    const identity=await f.verifier.authenticateAccessToken(token);
    assert.deepEqual(identity,{
      accountId:owner,clientId:client,resource,
      scopes:['mcp','offline_access'],sessionEpoch:0,
    });
    assert.ok(await f.legacy.authenticateAccessToken(token));
  }finally{f.close()}
});

test('logout denies even artificially unexpired legacy token after generation rollover',async()=>{
  const f=await fixture();try {
    const token=f.seed(owner,0,'would-be-resurrected');
    await f.transition('logout','logout-revoke-001');
    // Regression: simulate stale expiry restored by an unrelated writer,
    // which the old verifier alone would accept if expiry is in the future.
    f.sqlite.prepare('UPDATE mcp_oauth_access_tokens SET expires_at=? WHERE token_hash=?')
      .run('2026-10-16T12:00:00.000Z',hash(token));
    assert.ok(await f.legacy.authenticateAccessToken(token));
    assert.equal(await f.verifier.authenticateAccessToken(token),null);
  }finally{f.close()}
});

test('fresh independent reauth admits only new epoch and rejects prior generations',async()=>{
  const f=await fixture();try {
    const old=f.seed(owner,0,'old-generation');
    await f.transition('logout','logout-reauth-002');
    await f.transition('reauth','login-reauth-002');
    const current=f.seed(owner,2,'fresh-generation');
    assert.equal((await f.verifier.authenticateAccessToken(current))?.sessionEpoch,2);
    assert.equal(await f.verifier.authenticateAccessToken(old),null);
    await f.transition('logout','logout-again-002');
    assert.equal(await f.verifier.authenticateAccessToken(current),null);
  }finally{f.close()}
});

test('locked current generation rejects token despite not having expired',async()=>{
  const f=await fixture();try {
    await f.transition('logout','locked-003');
    const earlier=f.seed(second,0,'unaffected-by-owner-lock');
    assert.ok(await f.verifier.authenticateAccessToken(earlier));
    const token='nwx_mcp_injected-locked-token';
    // Inserting while locked is rejected by the staging trigger.
    assert.throws(()=>f.seed(owner,1,'injected-locked-token'),
      /oauth_access_session_epoch_denied/);
    assert.equal(await f.verifier.authenticateAccessToken(token),null);
  }finally{f.close()}
});

test('owner logout never invalidates a separate account token',async()=>{
  const f=await fixture();try{
    const foreign=f.seed(second,0,'foreign-stays-valid');
    await f.transition('logout','owner-only-004');
    assert.equal((await f.verifier.authenticateAccessToken(foreign))?.accountId,second);
  }finally{f.close()}
});

test('resource and MCP scope are mandatory',async()=>{
  const f=await fixture();try{
    const resourceBad=f.seed(owner,0,'wrong-resource',{resource:'https://wrong.example.test/mcp'});
    const scopeBad=f.seed(owner,0,'wrong-scope',{scopes:'["offline_access"]'});
    assert.equal(await f.verifier.authenticateAccessToken(resourceBad),null);
    assert.equal(await f.verifier.authenticateAccessToken(scopeBad),null);
  }finally{f.close()}
});

test('malformed scopes, future issuance and invalid expiration are denied',async()=>{
  const f=await fixture();try{
    const invalidScopes=f.seed(owner,0,'broken-scopes',{scopes:'not-json'});
    const future=f.seed(owner,0,'born-tomorrow',{created:'2026-10-16T12:00:00.000Z'});
    const malformedExpiry=f.seed(owner,0,'bad-expiry',{expires:'not-a-date'});
    assert.equal(await f.verifier.authenticateAccessToken(invalidScopes),null);
    assert.equal(await f.verifier.authenticateAccessToken(future),null);
    assert.equal(await f.verifier.authenticateAccessToken(malformedExpiry),null);
  }finally{f.close()}
});

test('missing account-generation row never grants a future-epoch token',async()=>{
  const f=await fixture();try{
    const token=f.seed(owner,0,'before-corruption');
    f.sqlite.prepare('UPDATE mcp_oauth_access_tokens SET session_epoch=8 WHERE token_hash=?')
      .run(hash(token));
    assert.equal(await f.verifier.authenticateAccessToken(token),null);
  }finally{f.close()}
});

test('mismatched generation fails closed, including after reauth',async()=>{
  const f=await fixture();try{
    await f.transition('logout','mismatch-logout-005');
    await f.transition('reauth','mismatch-reauth-005');
    const current=f.seed(owner,2,'generation-two');
    f.sqlite.prepare('UPDATE mcp_oauth_access_tokens SET session_epoch=0 WHERE token_hash=?')
      .run(hash(current));
    assert.equal(await f.verifier.authenticateAccessToken(current),null);
  }finally{f.close()}
});

test('missing epoch state after historical logout cannot reenable a legacy token',async()=>{
  const f=await fixture();try{
    const token=f.seed(owner,0,'historical-epoch-gap');
    await f.transition('logout','historical-gap-logout');
    f.sqlite.prepare('DELETE FROM mcp_oauth_session_epochs WHERE account_id=?').run(owner);
    f.sqlite.prepare('UPDATE mcp_oauth_access_tokens SET expires_at=? WHERE token_hash=?')
      .run('2026-10-16T12:00:00.000Z',hash(token));
    assert.equal(await f.verifier.authenticateAccessToken(token),null);
    const otherToken=f.seed(second,0,'other-still-legacy');
    assert.equal((await f.verifier.authenticateAccessToken(otherToken))?.accountId,second);
  }finally{f.close()}
});

test('invalid input and missing token return null without querying invalid credentials',async()=>{
  const f=await fixture();try{
    for (const token of ['', 'Bearer abc', 'nwx_refresh_mismatch', 'nwx_mcp_\r\nattack',
      'nwx_mcp_'+('a'.repeat(600)), 'nwx_mcp_missing']) {
      assert.equal(await f.verifier.authenticateAccessToken(token),null);
    }
  }finally{f.close()}
});

test('D1 outage fails closed rather than returning a stale cached identity',async()=>{
  const fail:D1DatabaseLike={
    prepare(){throw new Error('D1_READ_UNAVAILABLE')},
    async batch(){throw new Error('D1_READ_UNAVAILABLE')},
  };
  const verifier=new ProposedMcpOAuthEpochAccessVerifier({db:fail,resource,now:()=>clock});
  await assert.rejects(verifier.authenticateAccessToken('nwx_mcp_valid-looking'),
    /D1_READ_UNAVAILABLE/);
});

test('new atomic refresh access token is verified in epoch and denied after account logout',async()=>{
  const f=await fixture();try{
    await f.transition('logout','atomic-first-logout');
    await f.transition('reauth','atomic-first-login');
    const original='nwx_refresh_'+('x'.repeat(43));
    f.sqlite.prepare(
      'INSERT INTO mcp_oauth_refresh_tokens (token_hash,client_id,account_id,resource,scopes_json,expires_at,revoked_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(hash(original),client,owner,resource,'["mcp","offline_access"]',
      '2026-10-16T12:00:00.000Z',null,'2026-10-15T11:00:00.000Z',2);
    const rotator=new ProposedMcpOAuthEpochAtomicRefresh({
      db:f.db,resource,now:()=>clock,
    });
    const issued=await rotator.rotate({refreshToken:original,
      clientId:client,requestedResource:resource});
    const identity=await f.verifier.authenticateAccessToken(issued.access_token);
    assert.equal(identity?.accountId,owner);
    assert.equal(identity?.sessionEpoch,2);
    await f.transition('logout','atomic-second-logout');
    assert.equal(await f.verifier.authenticateAccessToken(issued.access_token),null);
    // A later fresh login must never resurrect the former refresh access.
    await f.transition('reauth','atomic-second-login');
    assert.equal(await f.verifier.authenticateAccessToken(issued.access_token),null);
  }finally{f.close()}
});

test('no identity cache: account revocation between independent requests is observed',async()=>{
  const f=await fixture();try{
    const token=f.seed(owner,0,'two-requests');
    assert.ok(await f.verifier.authenticateAccessToken(token));
    await f.transition('logout','after-first-request');
    assert.equal(await f.verifier.authenticateAccessToken(token),null);
  }finally{f.close()}
});
