import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginGitHubOAuthBrowserState,
  consumeGitHubOAuthBrowserState,
  githubOAuthStateDigest,
  revokeGitHubOAuthBrowserState,
} from '../src/product/github-oauth-browser-state.js';
import {
  D1IssuerFencedGitHubOAuthStateStore,
} from '../src/product/github-oauth-issuer-fence.js';

const origin='https://oauth-issuer.example.invalid';
const oldKey='synthetic-issuer-hmac-key-0001-not-production';
const newKey='synthetic-issuer-hmac-key-0002-not-production';
const alternateKey='synthetic-issuer-hmac-key-alternate-2026';
const now=new Date('2026-10-21T19:00:00.000Z');
const seconds=Math.floor(now.getTime()/1000);

function dbShim(db:DatabaseSync) {
  return {
    prepare(sql:string) {
      return {
        bind(...params:unknown[]) {
          return {
            async run() {
              const result=db.prepare(sql).run(
                ...params as Parameters<StatementSync['run']>);
              return {success:true,meta:{changes:Number(result.changes)}};
            },
          };
        },
      };
    },
  };
}
function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-oauth-epoch-fixture-'));
  const filename=path.join(dir,'issuer.sqlite');
  const a=new DatabaseSync(filename);
  a.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000');
  a.exec(
    'CREATE TABLE github_oauth_issuer_signers ('+
      'issuer TEXT PRIMARY KEY NOT NULL,signing_epoch INTEGER NOT NULL,'+
      'key_proof TEXT NOT NULL,changed_at INTEGER NOT NULL);'+
    'CREATE TABLE github_oauth_browser_states ('+
      'state_hash TEXT PRIMARY KEY NOT NULL,expires_at INTEGER NOT NULL,'+
      "status TEXT NOT NULL CHECK(status IN ('pending','consumed','revoked')),"+
      'changed_at INTEGER NOT NULL)',
  );
  const b=new DatabaseSync(filename);
  b.exec('PRAGMA busy_timeout=3000');
  const make=(db:DatabaseSync,epoch:number,key:string)=>
    new D1IssuerFencedGitHubOAuthStateStore(
      dbShim(db) as never,origin,epoch,key);
  return {
    a,b,make,
    close(){b.close();a.close();rmSync(dir,{recursive:true,force:true})},
    current(){
      return a.prepare('SELECT signing_epoch,key_proof FROM github_oauth_issuer_signers').get()
        as {signing_epoch:number;key_proof:string}|undefined;
    },
    status(state:string){
      return (a.prepare('SELECT status FROM github_oauth_browser_states WHERE state_hash=?')
        .get(githubOAuthStateDigest(state)) as {status:string}|undefined)?.status;
    },
  };
}
function begin(next:string,key:string) {
  return beginGitHubOAuthBrowserState(
    origin+'/auth/github/start',next,key,now);
}
function cb(state:string,cookie?:string) {
  return new Request(origin+'/auth/github/callback?code=synthetic&state='+
    encodeURIComponent(state),{
      headers:cookie?{cookie:cookie.split(';')[0]!}:{},
    });
}

test('issuer signing epoch advances monotonically and old pending states become unusable across two Workers',async()=>{
  const f=fixture();
  try{
    const old=f.make(f.a,7,oldKey);
    const newer=f.make(f.b,8,newKey);
    const earlier=begin('/old',oldKey);
    assert.equal(await old.issue(githubOAuthStateDigest(earlier.state),seconds+600,seconds),true);
    assert.equal(f.current()?.signing_epoch,7);
    const fresh=begin('/new',newKey);
    assert.equal(await newer.issue(githubOAuthStateDigest(fresh.state),seconds+600,seconds),true);
    assert.equal(f.current()?.signing_epoch,8);
    assert.equal(await consumeGitHubOAuthBrowserState(
      cb(earlier.state,earlier.cookie),earlier.state,oldKey,old,now),null);
    assert.equal(f.current()?.signing_epoch,8,'old Worker must never roll epoch backward');
    assert.equal(await old.issue(githubOAuthStateDigest(begin('/stale',oldKey).state),seconds+600,seconds),false);
    assert.deepEqual(await consumeGitHubOAuthBrowserState(
      cb(fresh.state,fresh.cookie),fresh.state,newKey,newer,now),{next:'/new'});
    assert.equal(f.status(earlier.state),'pending',
      'logical key-epoch revocation may retain a tombstone until cleanup');
    assert.equal(f.status(fresh.state),'consumed');
    assert.equal(f.current()?.signing_epoch,8);
  }finally{f.close()}
});

test('same-epoch foreign signer cannot replace key fingerprint or admit forged state',async()=>{
  const f=fixture();
  try{
    const first=f.make(f.a,3,oldKey);
    const forged=f.make(f.b,3,alternateKey);
    const s=begin('/owner',oldKey);
    assert.equal(await first.issue(githubOAuthStateDigest(s.state),seconds+600,seconds),true);
    const wrong=begin('/intruder',alternateKey);
    assert.equal(await forged.issue(githubOAuthStateDigest(wrong.state),seconds+600,seconds),false);
    assert.equal(await consumeGitHubOAuthBrowserState(cb(wrong.state,wrong.cookie),
      wrong.state,alternateKey,forged,now),null);
    assert.deepEqual(await consumeGitHubOAuthBrowserState(cb(s.state,s.cookie),
      s.state,oldKey,first,now),{next:'/owner'});
    assert.equal(f.status(wrong.state),undefined);
  }finally{f.close()}
});

test('explicit browser cancellation is owner-cookie bound and terminal even after key rollover',async()=>{
  const f=fixture();
  try{
    const old=f.make(f.a,2,oldKey);
    const newSigner=f.make(f.b,3,newKey);
    const s=begin('/owner-a',oldKey);
    const foreign=begin('/owner-b',oldKey);
    assert.equal(await old.issue(githubOAuthStateDigest(s.state),seconds+600,seconds),true);
    assert.equal(await old.issue(githubOAuthStateDigest(foreign.state),seconds+600,seconds),true);
    assert.equal(await revokeGitHubOAuthBrowserState(cb(s.state,foreign.cookie),
      s.state,oldKey,old,now),false);
    assert.equal(f.status(s.state),'pending');
    assert.equal(await revokeGitHubOAuthBrowserState(cb(s.state,s.cookie),
      s.state,oldKey,old,now),true);
    assert.equal(await revokeGitHubOAuthBrowserState(cb(s.state,s.cookie),
      s.state,oldKey,old,now),false);
    const current=begin('/owner-a-again',newKey);
    assert.equal(await newSigner.issue(githubOAuthStateDigest(current.state),seconds+600,seconds),true);
    assert.equal(await consumeGitHubOAuthBrowserState(cb(s.state,s.cookie),
      s.state,oldKey,old,now),null);
    assert.equal(f.status(s.state),'revoked');
    assert.deepEqual(await consumeGitHubOAuthBrowserState(
      cb(current.state,current.cookie),current.state,newKey,newSigner,now),
      {next:'/owner-a-again'});
  }finally{f.close()}
});

test('closed browser without cancel is bounded by ten-minute expiry and cannot be resurrected',async()=>{
  const f=fixture();
  try{
    const issuer=f.make(f.a,1,oldKey);
    const s=begin('/orphan',oldKey);
    assert.equal(await issuer.issue(githubOAuthStateDigest(s.state),seconds+600,seconds),true);
    assert.equal(await consumeGitHubOAuthBrowserState(
      cb(s.state),s.state,oldKey,issuer,now),null);
    assert.equal(await consumeGitHubOAuthBrowserState(
      cb(s.state,s.cookie),s.state,oldKey,issuer,
      new Date(now.getTime()+600_000)),null);
    assert.equal(await revokeGitHubOAuthBrowserState(
      cb(s.state,s.cookie),s.state,oldKey,issuer,
      new Date(now.getTime()+600_000)),false);
    assert.equal(f.status(s.state),'pending');
    // A closed tab emits no observable signal. Expiry denies; cleanup
    // of pending tombstones must be a separately audited D1 operation.
  }finally{f.close()}
});

test('issuer epoch DB outage is fail-closed; missing schema never grants a signed login',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const issuer=new D1IssuerFencedGitHubOAuthStateStore(
      dbShim(db) as never,origin,1,oldKey);
    const s=begin('/owner',oldKey);
    await assert.rejects(issuer.issue(
      githubOAuthStateDigest(s.state),seconds+600,seconds),
    /OAUTH_ISSUER_FENCE_UNAVAILABLE/);
  }finally{db.close()}
});
