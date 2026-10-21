import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginGitHubOAuthBrowserState,
  consumeGitHubOAuthBrowserState,
  D1GitHubOAuthStateConsumeStore,
  githubOAuthStateDigest,
  type GitHubOAuthStateConsumeStore,
} from '../src/product/github-oauth-browser-state.js';
import { githubOAuthStart, githubOAuthCallback } from '../src/product/github-oauth.js';
import { verifySessionToken } from '../src/product/control-plane-session.js';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { MemoryMcpOAuthStore } from '../src/product/memory-mcp-oauth-store.js';
import { McpOAuthService, McpOAuthError } from '../src/product/mcp-oauth.js';

const origin = 'https://issuer-a.invalid';
const url = origin + '/auth/github/start';
const callback = origin + '/auth/github/callback';
const keyOld = 'fake-issuer-hmac-signing-key-20261021-old-0001';
const keyNew = 'fake-issuer-hmac-signing-key-20261021-new-0002';
const resource = 'https://mcp.invalid/mcp';
const fixed = new Date('2026-10-21T16:00:00.000Z');

type SqliteFixture = {
  a: DatabaseSync;
  b: DatabaseSync;
  stores: [D1GitHubOAuthStateConsumeStore, D1GitHubOAuthStateConsumeStore];
  close():void;
};
function adapter(db: DatabaseSync) {
  return {
    prepare(query: string) {
      const sql=db.prepare(query);
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const result=sql.run(...args as Parameters<StatementSync['run']>);
              return {success:true,meta:{changes:Number(result.changes)}};
            },
          };
        },
      };
    },
  };
}
function fixture(): SqliteFixture {
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-07-csrf-hostile-'));
  const pathToDb=path.join(dir,'shared-fixture.sqlite');
  const a=new DatabaseSync(pathToDb);
  a.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL');
  a.exec(
    'CREATE TABLE github_oauth_browser_states ('+
    'state_hash TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, '+
    "status TEXT NOT NULL CHECK(status IN ('pending','consumed','revoked')), "+
    'changed_at INTEGER NOT NULL)',
  );
  const b=new DatabaseSync(pathToDb);
  b.exec('PRAGMA busy_timeout=3000');
  return {
    a,b,
    stores:[
      new D1GitHubOAuthStateConsumeStore(adapter(a) as never),
      new D1GitHubOAuthStateConsumeStore(adapter(b) as never),
    ],
    close(){b.close();a.close();rmSync(dir,{recursive:true,force:true})},
  };
}
function browserCookie(response:Response):string {
  const header=response.headers.get('set-cookie') ?? '';
  const cookie=header.split(';')[0] ?? '';
  assert.match(cookie,/^__Host-nwx_github_oauth=/);
  return cookie;
}
function stateOf(response:Response):string {
  assert.equal(response.status,302);
  return new URL(response.headers.get('location')!).searchParams.get('state')!;
}
function callbackRequest(state:string,secretCookie:string|null,code='ownerA'):Request {
  return new Request(callback+'?code='+code+'&state='+encodeURIComponent(state),{
    headers:secretCookie?{cookie:secretCookie}:{},
  });
}
function githubFake() {
  let exchange=0;
  let identity=0;
  const fetchImpl: typeof fetch = async (input,init) => {
    const endpoint=String(input);
    if (endpoint==='https://github.com/login/oauth/access_token') {
      exchange++;
      const payload=JSON.parse(String(init?.body)) as {code:string};
      return Response.json({access_token:'fake-github-'+payload.code});
    }
    if (endpoint==='https://api.github.com/user') {
      identity++;
      const header=new Headers(init?.headers).get('authorization') ?? '';
      const a=header.endsWith('ownerA');
      const b=header.endsWith('ownerB');
      assert.equal(a||b,true);
      return Response.json({
        id:a?333301:333302,login:a?'fixture-owner-a':'fixture-owner-b',
        name:null,email:null,
      });
    }
    throw new Error('Unexpected offline fixture endpoint');
  };
  return {fetchImpl,stats:()=>({exchange,identity})};
}
function loginConfig(
  nonceStore:GitHubOAuthStateConsumeStore,
  secret:string,fetchImpl:typeof fetch,
) {
  return {
    clientId:'fake-public-github-app-id',
    clientSecret:'fake-github-app-secret',
    sessionSecret:secret,
    stateConsumeStore:nonceStore,
    fetchImpl,
  };
}
function sessionFromCallback(response:Response,secret:string) {
  const header=response.headers.get('set-cookie') ?? '';
  const match=header.match(/(?:^|,\s*)nwx_session=([^;\s]+)/);
  assert.ok(match, 'successful owner login must contain a separate signed session cookie');
  return verifySessionToken(match[1]!,secret);
}
function count(db:DatabaseSync,status:string):number {
  const row=db.prepare(
    'SELECT COUNT(*) AS n FROM github_oauth_browser_states WHERE status=?',
  ).get(status) as {n:number};
  return row.n;
}

test('20-way simultaneous callbacks across two Workers: one authenticated owner-A, independent browser-B remains usable',async()=>{
  const db=fixture();
  try {
    const {fetchImpl,stats}=githubFake();
    const accounts=new MemoryControlPlaneStore();
    const control=new ControlPlaneService(accounts);
    const confA=loginConfig(db.stores[0],keyOld,fetchImpl);
    const confB=loginConfig(db.stores[1],keyOld,fetchImpl);
    const responseA=await githubOAuthStart(new Request(url+'?next=%2Fowner-a'),confA);
    const responseB=await githubOAuthStart(new Request(url+'?next=%2Fowner-b'),confB);
    const stateA=stateOf(responseA),stateB=stateOf(responseB);
    const cookieA=browserCookie(responseA),cookieB=browserCookie(responseB);
    assert.notEqual(cookieA,cookieB);

    // A stolen state value by itself, or the other browser's session, is
    // insufficient even when an attacker offers a valid GitHub identity code.
    const crossed=await Promise.all([
      githubOAuthCallback(callbackRequest(stateA,cookieB,'ownerB'),control,confA),
      githubOAuthCallback(callbackRequest(stateB,cookieA,'ownerA'),control,confB),
      githubOAuthCallback(callbackRequest(stateA,null,'ownerB'),control,confB),
    ]);
    assert.deepEqual(crossed.map(x=>x.status),[400,400,400]);
    assert.deepEqual(stats(),{exchange:0,identity:0});

    // Deterministic barrier ensures every valid callback reaches the CAS
    // gate before any can update the single durable shared SQLite row.
    let waiting=0;
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve});
    const workers=Array.from({length:2},(_,i):GitHubOAuthStateConsumeStore=>({
      issue:(...args)=>db.stores[i]!.issue(...args),
      revoke:(...args)=>db.stores[i]!.revoke(...args),
      async consumeOnce(...args) {
        waiting++;
        if(waiting===20)release();
        await gate;
        return db.stores[i]!.consumeOnce(...args);
      },
    }));
    const calls=Array.from({length:20},(_,i)=>
      githubOAuthCallback(
        callbackRequest(stateA,cookieA,'ownerA'),
        control,loginConfig(workers[i%2]!,keyOld,fetchImpl),
      ));
    const result=await Promise.all(calls);
    assert.equal(waiting,20);
    assert.equal(result.filter(x=>x.status===302).length,1);
    assert.equal(result.filter(x=>x.status===400).length,19);
    assert.deepEqual(stats(),{exchange:1,identity:1});
    const success=result.find(x=>x.status===302)!;
    assert.equal(success.headers.get('location'),'/owner-a');
    const ownerA=sessionFromCallback(success,keyOld);
    assert.ok(ownerA);
    assert.equal(ownerA.role,'user');
    assert.equal(count(db.a,'consumed'),1);
    assert.equal(count(db.a,'pending'),1);

    // The other browser's state and signed cookie still work independently.
    const b=await githubOAuthCallback(callbackRequest(stateB,cookieB,'ownerB'),control,confB);
    assert.equal(b.status,302);
    assert.equal(b.headers.get('location'),'/owner-b');
    const ownerB=sessionFromCallback(b,keyOld);
    assert.ok(ownerB);
    assert.notEqual(ownerA.accountId,ownerB.accountId);
    assert.equal(ownerB.role,'user');
    assert.deepEqual(stats(),{exchange:2,identity:2});
    assert.equal(count(db.a,'consumed'),2);
    assert.equal((await accounts.listAccounts()).length,2);
  } finally {db.close()}
});

test('issuer/login signing-key rotation rejects old state with new key and revocation prevents key rollback resurrection',async()=>{
  const db=fixture();
  try {
    const seconds=Math.floor(fixed.getTime()/1000);
    const old=beginGitHubOAuthBrowserState(url,'/old',keyOld,fixed);
    const newer=beginGitHubOAuthBrowserState(url,'/new',keyNew,fixed);
    assert.equal(await db.stores[0].issue(githubOAuthStateDigest(old.state),seconds+600,seconds),true);
    assert.equal(await db.stores[1].issue(githubOAuthStateDigest(newer.state),seconds+600,seconds),true);
    assert.equal(await consumeGitHubOAuthBrowserState(
      callbackRequest(old.state,old.cookie.split(';')[0]!),
      old.state,keyNew,db.stores[1],fixed),null);
    assert.deepEqual(await consumeGitHubOAuthBrowserState(
      callbackRequest(newer.state,newer.cookie.split(';')[0]!),
      newer.state,keyNew,db.stores[0],fixed),{next:'/new'});
    // There is no automatic issuer-key epoch binding in #675: rotation must
    // revoke outstanding old-key pending states through trusted shared CAS.
    assert.equal(await db.stores[1].revoke(githubOAuthStateDigest(old.state),seconds),true);
    assert.equal(await consumeGitHubOAuthBrowserState(
      callbackRequest(old.state,old.cookie.split(';')[0]!),
      old.state,keyOld,db.stores[0],fixed),null);
    assert.equal(count(db.a,'revoked'),1);
    assert.equal(count(db.a,'consumed'),1);
  } finally {db.close()}
});

test('aborted tab: missing cookie cannot consume; explicit cancel or expiry rejects even after restoring cookie',async()=>{
  const db=fixture();
  try {
    const seconds=Math.floor(fixed.getTime()/1000);
    const abandoned=beginGitHubOAuthBrowserState(url,'/abandoned',keyOld,fixed);
    const expired=beginGitHubOAuthBrowserState(url,'/expired',keyOld,fixed);
    for(const value of [abandoned,expired]) {
      assert.equal(await db.stores[0].issue(githubOAuthStateDigest(value.state),seconds+600,seconds),true);
    }
    assert.equal(await consumeGitHubOAuthBrowserState(
      callbackRequest(abandoned.state,null),abandoned.state,keyOld,db.stores[1],fixed),null);
    assert.equal(await db.stores[1].revoke(githubOAuthStateDigest(abandoned.state),seconds+1),true);
    assert.equal(await consumeGitHubOAuthBrowserState(
      callbackRequest(abandoned.state,abandoned.cookie.split(';')[0]!),
      abandoned.state,keyOld,db.stores[0],new Date(fixed.getTime()+1500)),null);
    assert.equal(await consumeGitHubOAuthBrowserState(
      callbackRequest(expired.state,expired.cookie.split(';')[0]!),
      expired.state,keyOld,db.stores[0],new Date(fixed.getTime()+600_000)),null);
    assert.equal(count(db.a,'consumed'),0);
    assert.equal(count(db.a,'revoked'),1);
    assert.equal(count(db.a,'pending'),1,
      'expired pending tombstone needs audited cleanup, not phantom consumption');
    // A closed browser tab cannot automatically notify this source adapter;
    // browser cancellation must invoke a trusted revoke request, or expire.
  }finally{db.close()}
});

test('refresh-after-revoke: access-only revocation does not close refresh; explicit refresh revoke is terminal and owner-scoped',async()=>{
  const store=new MemoryMcpOAuthStore();
  const oauth=new McpOAuthService(store,{issuer:origin,resource});
  const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
  const client=await oauth.registerClient({
    redirect_uris:[redirect],token_endpoint_auth_method:'none',
  }) as {client_id:string};
  const verifier='ABCDEFGHIJKLMNOPQRSTUVabcdefghijklmnopqrstuv0123456789-._~';
  const pkce=createHash('sha256').update(verifier,'ascii').digest('base64url');
  const issue=async (owner:string)=>{
    const authorization=new URL(await oauth.authorize(owner,new URLSearchParams({
      response_type:'code',client_id:client.client_id,redirect_uri:redirect,
      code_challenge:pkce,code_challenge_method:'S256',resource,
      scope:'mcp offline_access',state:'synthetic-client-csrf-not-windows-token',
    })));
    return oauth.token(new URLSearchParams({
      grant_type:'authorization_code',code:authorization.searchParams.get('code')!,
      client_id:client.client_id,redirect_uri:redirect,code_verifier:verifier,resource,
    }));
  };
  const a=await issue('owner-a');
  const b=await issue('owner-b');
  assert.equal(await oauth.invalidateAccessToken(a.access_token,'owner-b'),false);
  assert.equal(await oauth.invalidateAccessToken(a.access_token,'owner-a'),true);
  assert.equal(await oauth.authenticateAccessToken(a.access_token),null);
  // Explicitly distinguish 'revoke one access token' from whole-session
  // logout: the refresh grant remains valid (known production gap).
  const rotated=await oauth.token(new URLSearchParams({
    grant_type:'refresh_token',refresh_token:a.refresh_token!,
    client_id:client.client_id,resource,
  }));
  assert.equal((await oauth.authenticateAccessToken(rotated.access_token))?.accountId,'owner-a');
  const revokeHash=createHash('sha256').update(rotated.refresh_token!).digest('hex');
  assert.equal(await store.consumeRefreshToken(revokeHash,new Date().toISOString()),true);
  await assert.rejects(oauth.token(new URLSearchParams({
    grant_type:'refresh_token',refresh_token:rotated.refresh_token!,
    client_id:client.client_id,resource,
  })),(error:unknown)=>error instanceof McpOAuthError&&error.code==='invalid_grant');
  assert.equal((await oauth.authenticateAccessToken(b.access_token))?.accountId,'owner-b');
  assert.ok(b.refresh_token);
});
