import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginGitHubOAuthBrowserState, consumeGitHubOAuthBrowserState,
  D1GitHubOAuthStateConsumeStore, MemoryGitHubOAuthStateConsumeStore,
  githubOAuthStateDigest,
  type GitHubOAuthStateConsumeStore,
} from '../src/product/github-oauth-browser-state.js';
import { githubOAuthStart, githubOAuthCallback } from '../src/product/github-oauth.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';

const secret = 'a-synthetic-not-production-secret-123456789';
const foreignSecret = 'a-different-synthetic-secret-123456789';
const origin = 'https://nexowire.test.invalid';
const callbackPath = '/auth/github/callback';
const startPath = '/auth/github/start';
const now = new Date('2026-10-21T18:00:00.000Z');

function cookie(start: {cookie:string}): string {
  return start.cookie.split(';')[0]!;
}
async function beginIssued(store:GitHubOAuthStateConsumeStore,next='/dashboard') {
  const start=beginGitHubOAuthBrowserState(origin+startPath,next,secret,now);
  assert.equal(await store.issue(githubOAuthStateDigest(start.state),
    Math.floor(now.getTime()/1000)+600,Math.floor(now.getTime()/1000)),true);
  return start;
}
function request(state: string, browserCookie?: string, requestOrigin=origin) {
  return new Request(requestOrigin + callbackPath + '?code=fixture&state=' +
    encodeURIComponent(state), {
      headers:browserCookie ? {cookie:browserCookie} : {},
  });
}
function fakeD1(db: DatabaseSync) {
  return {
    prepare(sql:string) {
      let statement = db.prepare(sql);
      let bound:unknown[] = [];
      return {
        bind(...args:unknown[]) {bound = args; return this;},
        async run() {
          const info = statement.run(...bound as Parameters<typeof statement.run>);
          return {success:true,meta:{changes:Number(info.changes)}};
        },
      };
    },
  };
}

test('browser-bound v2 state consumes once before GitHub exchange, replay and concurrent duplicate denied', async () => {
  const store = new MemoryGitHubOAuthStateConsumeStore();
  const start=await beginIssued(store);
  assert.match(start.cookie,/__Host-nwx_github_oauth=/);
  assert.match(start.cookie,/HttpOnly/);
  assert.match(start.cookie,/Secure/);
  assert.match(start.cookie,/SameSite=Lax/);
  assert.match(start.cookie,/Path=\//);
  assert.doesNotMatch(start.state,/nwx_github_oauth|fixture-secret/);
  const r = request(start.state,cookie(start));
  const outcomes = await Promise.all(Array.from({length:20},()=>
    consumeGitHubOAuthBrowserState(r,start.state,secret,store,now)));
  assert.equal(outcomes.filter(x=>x?.next==='/dashboard').length,1);
  assert.equal(outcomes.filter(x=>x===null).length,19);
  assert.equal(await consumeGitHubOAuthBrowserState(r,start.state,secret,store,now),null);
});

test('forged signature, foreign browser, missing/duplicate cookie, wrong host and old v1 state are denied without consuming', async () => {
  const store = new MemoryGitHubOAuthStateConsumeStore();
  const start=await beginIssued(store);
  const other = await beginIssued(store,'/attacker');
  const [payload,signature]=start.state.split('.');
  assert.ok(payload && signature);
  const altered = JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as Record<string,unknown>;
  altered.next='/admin';
  const forged = Buffer.from(JSON.stringify(altered)).toString('base64url') + '.' + signature;
  for (const bad of [
    [forged,cookie(start),origin],
    [start.state,cookie(other),origin],
    [start.state,undefined,origin],
    [start.state,cookie(start)+'; '+cookie(start),origin],
    [start.state,cookie(start),'https://foreign.test.invalid'],
    [start.state+'.extra',cookie(start),origin],
  ] as Array<[string,string|undefined,string]>) {
    assert.equal(await consumeGitHubOAuthBrowserState(
      request(bad[0],bad[1],bad[2]),bad[0],secret,store,now),null);
  }
  assert.equal(await consumeGitHubOAuthBrowserState(request(start.state,cookie(start)),
    start.state,foreignSecret,store,now),null);
  assert.equal(await consumeGitHubOAuthBrowserState(request(start.state,cookie(start)),
    start.state,secret,store,new Date(now.getTime()+600_000)),null);
  assert.deepEqual(await consumeGitHubOAuthBrowserState(request(start.state,cookie(start)),
    start.state,secret,store,now),{next:'/dashboard'});
});

test('github login refuses missing durable replay store; legacy signed state cannot authenticate', async () => {
  const service = new ControlPlaneService(new MemoryControlPlaneStore());
  const config = {clientId:'fixture-client',clientSecret:'fixture-secret',
    sessionSecret:secret};
  await assert.rejects(githubOAuthStart(new Request(origin+startPath),config),
    /OAUTH_STATE_STORE_UNAVAILABLE/);
  const result = await githubOAuthCallback(
    request('legacy-v1-signed-state',undefined),service,config);
  assert.equal(result.status,503);
  assert.equal((await result.json() as {error:string}).error,'OAUTH_STATE_STORE_UNAVAILABLE');
});

test('a consumed callback state is never replayed after GitHub failure; foreign browser cannot exchange', async () => {
  const counter={exchange:0};
  const stateStore = new MemoryGitHubOAuthStateConsumeStore();
  const control = new ControlPlaneService(new MemoryControlPlaneStore());
  const config = {
    clientId:'synthetic-github-client',clientSecret:'synthetic-github-secret',
    sessionSecret:secret,stateConsumeStore:stateStore,
    fetchImpl: async () => {
      counter.exchange++;
      return Response.json({error:'bad_verification_code'}, {status:502});
    },
  };
  const start=await githubOAuthStart(new Request(origin+startPath+'?next=%2Fdashboard'),config);
  const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
  const secretCookie=start.headers.get('set-cookie')!.split(';')[0]!;
  const foreign = await githubOAuthCallback(request(state),control,config);
  assert.equal(foreign.status,400);
  assert.equal(counter.exchange,0);
  const callback=await githubOAuthCallback(request(state,secretCookie),control,config);
  assert.equal(callback.status,502);
  assert.equal(counter.exchange,1);
  const replay=await githubOAuthCallback(request(state,secretCookie),control,config);
  assert.equal(replay.status,400);
  assert.equal(counter.exchange,1);
});

test('pre-callback revoke is terminal; consumed state cannot be revoked or exchanged again', async () => {
  const store=new MemoryGitHubOAuthStateConsumeStore();
  const pending=await beginIssued(store,'/keep-safe');
  const hash=githubOAuthStateDigest(pending.state);
  const at=Math.floor(now.getTime()/1000);
  assert.equal(await store.revoke(hash,at),true);
  assert.equal(await store.revoke(hash,at),false);
  assert.equal(await consumeGitHubOAuthBrowserState(
    request(pending.state,cookie(pending)),pending.state,secret,store,now),null);
  const second=await beginIssued(store,'/second');
  assert.deepEqual(await consumeGitHubOAuthBrowserState(
    request(second.state,cookie(second)),second.state,secret,store,now),
    {next:'/second'});
  assert.equal(await store.revoke(githubOAuthStateDigest(second.state),at),false);
  assert.equal(await consumeGitHubOAuthBrowserState(
    request(second.state,cookie(second)),second.state,secret,store,now),null);
});

test('revoked pending GitHub callback cannot exchange code or create an account session', async () => {
  const stateStore=new MemoryGitHubOAuthStateConsumeStore();
  const control=new ControlPlaneService(new MemoryControlPlaneStore());
  let githubCalls=0;
  const config={
    clientId:'fixture-app',clientSecret:'fixture-secret',sessionSecret:secret,
    stateConsumeStore:stateStore,
    fetchImpl: async () => {
      githubCalls++;
      return Response.json({access_token:'synthetic-reply-only'});
    },
  };
  const started=await githubOAuthStart(new Request(origin+startPath),config);
  const state=new URL(started.headers.get('location')!).searchParams.get('state')!;
  assert.equal(await stateStore.revoke(githubOAuthStateDigest(state),
    Math.floor(Date.now()/1000)),true);
  const reply=await githubOAuthCallback(request(state,started.headers.get('set-cookie')!.split(';')[0]!),
    control,config);
  assert.equal(reply.status,400);
  assert.equal(reply.headers.get('set-cookie'),null);
  assert.equal(githubCalls,0);
  assert.equal((await control.dashboard({accountId:'fixture-app',role:'user'}).catch(()=>null)),null);
});

test('failed state issuance produces neither OAuth redirect nor session', async () => {
  const stateConsumeStore:GitHubOAuthStateConsumeStore={
    issue:async ()=>{throw new Error('sensitive D1 error: no production data');},
    consumeOnce:async ()=>{throw new Error('unreachable');},
    revoke:async ()=>false,
  };
  await assert.rejects(githubOAuthStart(new Request(origin+startPath),{
    clientId:'fixture-app',clientSecret:'fixture-secret',sessionSecret:secret,
    stateConsumeStore,
  }),/sensitive D1 error/);
  // The source-only caller must map this exception to generic 503 (Worker
  // currently has a guarded source-level catch; production wiring BLOCKED).
});

test('D1-style atomic unique insert blocks replay across two workers and storage outages fail closed', async () => {
  const temp=mkdtempSync(path.join(tmpdir(),'nwx-csrf-isolated-'));
  const file=path.join(temp,'nonce-fixture.sqlite');
  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  try {
    a.exec('CREATE TABLE github_oauth_browser_states (' +
      'state_hash TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, ' +
      "status TEXT NOT NULL CHECK(status IN ('pending','consumed','revoked')), " +
      'changed_at INTEGER NOT NULL)');
    const workers:GitHubOAuthStateConsumeStore[] = [
      new D1GitHubOAuthStateConsumeStore(fakeD1(a) as never),
      new D1GitHubOAuthStateConsumeStore(fakeD1(b) as never),
    ];
    const start=await beginIssued(workers[0]!,'/ok');
    const r=request(start.state,cookie(start));
    const results=await Promise.all(Array.from({length:12},(_,i)=>
      consumeGitHubOAuthBrowserState(r,start.state,secret,
        workers[i%2]!,now)));
    assert.equal(results.filter(x=>x?.next==='/ok').length,1);
    assert.equal(results.filter(x=>x===null).length,11);
    assert.equal((a.prepare('SELECT COUNT(*) AS n FROM github_oauth_browser_states')
      .get() as {n:number}).n,1);
    assert.equal((a.prepare("SELECT status FROM github_oauth_browser_states")
      .get() as {status:string}).status,'consumed');

    const revoked=await beginIssued(workers[0]!,'/revoked');
    const revokedDigest=githubOAuthStateDigest(revoked.state);
    assert.equal(await workers[1]!.revoke(revokedDigest,Math.floor(now.getTime()/1000)),true);
    assert.equal(await consumeGitHubOAuthBrowserState(request(revoked.state,cookie(revoked)),
      revoked.state,secret,workers[0]!,now),null);
    assert.equal((a.prepare("SELECT status FROM github_oauth_browser_states WHERE state_hash=?")
      .get(revokedDigest) as {status:string}).status,'revoked');

    const unavailableStore:GitHubOAuthStateConsumeStore = {
      issue: async () => {throw new Error('DB outage: private diagnostic');},
      consumeOnce: async () => {throw new Error('DB outage: private diagnostic');},
      revoke: async () => {throw new Error('DB outage: private diagnostic');},
    };
    const newStart=await beginIssued(workers[0]!,'/ok');
    await assert.rejects(consumeGitHubOAuthBrowserState(
      request(newStart.state,cookie(newStart)),newStart.state,secret,
      unavailableStore,now),/OAUTH_STATE_STORE_UNAVAILABLE/);
    assert.equal((a.prepare('SELECT COUNT(*) AS n FROM github_oauth_browser_states')
      .get() as {n:number}).n,3);
  } finally {
    b.close();a.close();rmSync(temp,{recursive:true,force:true});
  }
});
