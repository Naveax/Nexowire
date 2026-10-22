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
import {D1McpOAuthStore} from '../src/product/d1-mcp-oauth-store.js';
import {McpOAuthService,McpOAuthError} from '../src/product/mcp-oauth.js';
import {MemoryMcpOAuthStore} from '../src/product/memory-mcp-oauth-store.js';
import {FirstPartyMcpOAuthLogoutBoundary} from '../src/product/mcp-oauth-first-party-logout.js';
import {ProposedMcpOAuthSessionEpoch} from '../src/product/mcp-oauth-session-epoch-proposal.js';
import {ProposedMcpOAuthEpochAtomicRefresh} from '../src/product/mcp-oauth-atomic-epoch-refresh-proposal.js';
import {ProposedMcpOAuthEpochAccessVerifier} from '../src/product/mcp-oauth-epoch-access-verifier-proposal.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly sql:StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Statement(this.sql,args)}
  async first<T>():Promise<T|null>{
    return (this.sql.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null;
  }
  async all<T>():Promise<D1ResultLike<T>>{
    return {success:true,results:this.sql.all(...this.args as Parameters<StatementSync['all']>) as T[]};
  }
  async run<T>():Promise<D1ResultLike<T>>{
    const out=this.sql.run(...this.args as Parameters<StatementSync['run']>);
    return {success:true,meta:{changes:Number(out.changes)}};
  }
}
class Adapter implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Statement(this.db.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN');
    try {
      const out:D1ResultLike[]=[];
      for(const s of items)out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch(err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
const at=new Date('2026-10-21T18:00:00.000Z');
const ownerA='trusted-owner-a';
const ownerB='trusted-owner-b';
const client='oauth-client-07-fixture';
const resource='https://mcp-issuer.invalid/mcp';
const digest=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
// Fixture-only invalid-token authority for tests exercising refresh failures.
const denyAccess={authenticateAccessToken:async(_rawToken:string)=>null};

test('first-party owner logout after access revoke locks concurrent refresh while foreign owner unaffected',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys=ON');
    for(const name of ['0001_control_plane.sql','0002_external_identities.sql',
      '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
      '0005_mcp_oauth.sql']){
      sqlite.exec(readFileSync(path.join(process.cwd(),'cloudflare/migrations',name),'utf8'));
    }
    for(const name of ['scale-v2-s1-oauth-logout-staging.sql',
      'scale-v2-s1-oauth-session-epoch-staging.sql',
      'scale-v2-s1-oauth-atomic-refresh-staging.sql']){
      sqlite.exec(readFileSync(path.join(process.cwd(),'test/fixtures',name),'utf8'));
    }
    const db=new Adapter(sqlite);
    const control=new ControlPlaneService(new D1ControlPlaneStore(db),{now:()=>at});
    await control.ensureAccount({id:ownerA});
    await control.ensureAccount({id:ownerB});
    sqlite.prepare(
      'INSERT INTO mcp_oauth_clients(client_id,redirect_uris_json,token_endpoint_auth_method,created_at) VALUES(?,?,?,?)'
    ).run(client,'[]','none',at.toISOString());
    const seed=(accountId:string,suffix:string)=>{
      const access='nwx_mcp_'+suffix.repeat(40);
      const refresh='nwx_refresh_'+suffix.repeat(40);
      sqlite.prepare(
        'INSERT INTO mcp_oauth_session_epochs(account_id,generation,locked,changed_at) VALUES (?,0,0,?)'
      ).run(accountId,at.toISOString());
      sqlite.prepare(
        'INSERT INTO mcp_oauth_access_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,?,0)'
      ).run(digest(access),client,accountId,resource,'["mcp","offline_access"]',
        new Date(at.getTime()+3600_000).toISOString(),at.toISOString());
      sqlite.prepare(
        'INSERT INTO mcp_oauth_refresh_tokens(token_hash,client_id,account_id,resource,scopes_json,expires_at,revoked_at,created_at,session_epoch) VALUES (?,?,?,?,?,?,NULL,?,0)'
      ).run(digest(refresh),client,accountId,resource,'["mcp","offline_access"]',
        new Date(at.getTime()+3600_000).toISOString(),at.toISOString());
      return {access,refresh};
    };
    const a=seed(ownerA,'A');
    const b=seed(ownerB,'B');
    const oauth=new McpOAuthService(new D1McpOAuthStore(db),{
      issuer:'https://mcp-issuer.invalid',resource,now:()=>at,
    });
    // First revoke one access credential. It does NOT clear its refresh.
    assert.equal(await oauth.invalidateAccessToken(a.access,ownerA),true);
    const oldRefresh=sqlite.prepare(
      'SELECT revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash=?'
    ).get(digest(a.refresh)) as {revoked_at:string|null};
    assert.equal(oldRefresh.revoked_at,null);
    const epoch=new ProposedMcpOAuthSessionEpoch({
      db,verifyCurrentOwner:async()=>true,
      verifyFreshFirstPartyLogin:async()=>true,now:()=>at,
    });
    const boundary=new FirstPartyMcpOAuthLogoutBoundary({
      verifyFirstPartyOwnerSession:async proof=>
        proof==='SIGNED_FIRST_PARTY_OWNER_A_SESSION'
          ? {accountId:ownerA,role:'user'} : null,
      epoch,
    });
    const spoof=await boundary.logout({
      firstPartySessionProof:'nwx_refresh_'+('A'.repeat(40)),
      targetAccountId:ownerA,operationId:'logout-denied-bearer',
    });
    assert.equal(spoof.status,'denied');
    const foreign=await boundary.logout({
      firstPartySessionProof:'SIGNED_FIRST_PARTY_OWNER_A_SESSION',
      targetAccountId:ownerB,operationId:'logout-denied-foreign',
    });
    assert.equal(foreign.status,'denied');
    const accepted=await boundary.logout({
      firstPartySessionProof:'SIGNED_FIRST_PARTY_OWNER_A_SESSION',
      targetAccountId:ownerA,operationId:'logout-owner-a-0001',
    });
    assert.equal(accepted.status,'transitioned');
    assert.equal((await epoch.state(ownerA)).locked,true);
    assert.equal((await epoch.state(ownerB)).locked,false);
    // The trusted staging logout trigger revokes the owner's refresh records
    // AND locks the epoch. Rotation correctly denies the revoked credential
    // at its earlier lookup gate, before reaching the session-epoch gate.
    // Never weaken the revocation trigger to make an expected error match.
    const refreshRow=(token:string)=>sqlite.prepare(
      'SELECT account_id,session_epoch,revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash=?'
    ).get(digest(token)) as {
      account_id:string;session_epoch:number;revoked_at:string|null
    };
    // Node 22 node:sqlite returns a null-prototype row. Compare security
    // fields directly rather than requiring an Object.prototype identity.
    const revokedOwner=refreshRow(a.refresh);
    assert.equal(revokedOwner.account_id,ownerA);
    assert.equal(revokedOwner.session_epoch,0);
    assert.equal(revokedOwner.revoked_at,at.toISOString());
    const unrelatedOwner=refreshRow(b.refresh);
    assert.equal(unrelatedOwner.account_id,ownerB);
    assert.equal(unrelatedOwner.session_epoch,0);
    assert.equal(unrelatedOwner.revoked_at,null);
    assert.equal(await oauth.authenticateAccessToken(a.access),null);
    const beforeOwnerA=(sqlite.prepare(
      'SELECT COUNT(*) AS n FROM mcp_oauth_access_tokens WHERE account_id=?'
    ).get(ownerA) as {n:number}).n;
    const rotator=new ProposedMcpOAuthEpochAtomicRefresh({db,resource,now:()=>at});
    const epochVerifier=new ProposedMcpOAuthEpochAccessVerifier({db,resource,now:()=>at});
    // Exercise the *actual* McpOAuthService.token() routing, not just the
    // staging proposal directly. A selected epoch-atomic authority cannot
    // fall back to legacy consumeRefreshToken/issueTokens on denial.
    const strictIssuer=new McpOAuthService(new D1McpOAuthStore(db),{
      issuer:'https://mcp-issuer.invalid',resource,now:()=>at,
      refreshMode:'epoch-atomic',epochAtomicRefresh:rotator,
      epochAccessVerifier:epochVerifier,
    });
    const rotate=(refresh:string)=>strictIssuer.token(new URLSearchParams({
      grant_type:'refresh_token',refresh_token:refresh,
      client_id:client,resource,
    }));
    // Concurrent retries of an already revoked refresh may never mint a
    // new token or unlock the session. This is an expected fail-closed path.
    const replay=await Promise.allSettled(Array.from({length:8},()=>rotate(a.refresh)));
    assert.equal(replay.filter(x=>x.status==='fulfilled').length,0);
    for(const denial of replay) {
      assert.equal(denial.status,'rejected');
      const reason=(denial as PromiseRejectedResult).reason;
      assert.equal(reason instanceof McpOAuthError,true);
      assert.equal((reason as McpOAuthError).code,'invalid_grant');
    }
    assert.equal((sqlite.prepare(
      'SELECT COUNT(*) AS n FROM mcp_oauth_access_tokens WHERE account_id=?'
    ).get(ownerA) as {n:number}).n,beforeOwnerA);
    assert.equal(refreshRow(a.refresh).revoked_at,at.toISOString());
    // Simulate a hostile stale writer reviving an old access expiry after
    // logout. The unprotected legacy verifier would trust the row, while
    // the issuer's strict verifier must consult the current locked epoch.
    sqlite.prepare(
      'UPDATE mcp_oauth_access_tokens SET expires_at=? WHERE token_hash=?'
    ).run(new Date(at.getTime()+3600_000).toISOString(),digest(a.access));
    assert.ok(await oauth.authenticateAccessToken(a.access));
    assert.equal(await strictIssuer.authenticateAccessToken(a.access),null);
    assert.equal((await strictIssuer.authenticateAccessToken(b.access))?.accountId,ownerB);
    const unrelated=await rotate(b.refresh);
    assert.match(unrelated.access_token,/^nwx_mcp_/);
    assert.ok(unrelated.refresh_token,'atomic refresh must issue the next refresh grant');
    assert.match(unrelated.refresh_token,/^nwx_refresh_/);
    const row=sqlite.prepare(
      'SELECT account_id FROM mcp_oauth_access_tokens WHERE token_hash=?'
    ).get(digest(unrelated.access_token)) as {account_id:string};
    assert.equal(row.account_id,ownerB);
    assert.equal((await strictIssuer.authenticateAccessToken(unrelated.access_token))?.accountId,ownerB);
  } finally {sqlite.close()}
});


test('strict issuer refresh refuses missing authority, unknown DB failure and any legacy fallback',async()=>{
  const store=new MemoryMcpOAuthStore();
  const options={issuer:'https://mcp-issuer.invalid',resource,now:()=>at};
  assert.throws(()=>new McpOAuthService(store,{
    ...options,refreshMode:'epoch-atomic',
    epochAccessVerifier:denyAccess,
  }),/OAUTH_ATOMIC_REFRESH_AUTHORITY_REQUIRED/);
  assert.throws(()=>new McpOAuthService(store,{
    ...options,epochAtomicRefresh:{rotate:async()=>{throw Error('unreachable')}},
  }),/OAUTH_ATOMIC_REFRESH_AUTHORITY_REQUIRED/);
  assert.throws(()=>new McpOAuthService(store,{
    ...options,refreshMode:'epoch-atomic',
    epochAtomicRefresh:{rotate:async()=>{throw Error('unreachable')}},
  }),/OAUTH_ATOMIC_REFRESH_AUTHORITY_REQUIRED/);
  assert.throws(()=>new McpOAuthService(store,{
    ...options,refreshMode:'epoch-atomic',
    epochAccessVerifier:denyAccess,
  }),/OAUTH_ATOMIC_REFRESH_AUTHORITY_REQUIRED/);

  const old='nwx_refresh_'+('Z'.repeat(43));
  await store.putRefreshToken({
    tokenHash:digest(old),clientId:client,accountId:ownerA,resource,
    scopes:['mcp','offline_access'],
    expiresAt:new Date(at.getTime()+3600_000).toISOString(),
    revokedAt:null,createdAt:at.toISOString(),
  });
  let calls=0;
  const strict=new McpOAuthService(store,{
    ...options,refreshMode:'epoch-atomic',
    epochAccessVerifier:denyAccess,
    epochAtomicRefresh:{
      async rotate(){calls++;throw Error('SYNTHETIC_D1_UNAVAILABLE')},
    },
  });
  const form=new URLSearchParams({
    grant_type:'refresh_token',refresh_token:old,client_id:client,resource,
  });
  await assert.rejects(strict.token(form),/SYNTHETIC_D1_UNAVAILABLE/);
  assert.equal(calls,1);
  // The inserted legacy refresh is still unused. Never mint a fallback
  // token pair or retry a possibly committed remote atomic mutation.
  assert.equal((await store.getRefreshToken(digest(old)))?.revokedAt,null);
  assert.equal(await store.getAccessToken(digest('synthetic-new-access')),null);

  const forged=new McpOAuthService(store,{
    ...options,refreshMode:'epoch-atomic',
    epochAccessVerifier:denyAccess,
    epochAtomicRefresh:{async rotate(){return {
      access_token:'invalid',
      refresh_token:'invalid',
      token_type:'Bearer' as const,expires_in:3600,scope:'mcp offline_access',
    }}},
  });
  await assert.rejects(forged.token(form),/OAUTH_ATOMIC_REFRESH_RESPONSE_UNVERIFIED/);
  assert.equal((await store.getRefreshToken(digest(old)))?.revokedAt,null);
});

test('strict issuer checks resource before calling trusted atomic refresher',async()=>{
  const store=new MemoryMcpOAuthStore();
  let touched=0;
  const strict=new McpOAuthService(store,{
    issuer:'https://mcp-issuer.invalid',resource,now:()=>at,
    refreshMode:'epoch-atomic',
    epochAccessVerifier:denyAccess,
    epochAtomicRefresh:{async rotate(){touched++;throw Error('unreachable')}},
  });
  for(const fields of [
    {client_id:client,resource:'https://other.invalid/mcp'},
    {client_id:'',resource},
  ]) {
    await assert.rejects(strict.token(new URLSearchParams({
      grant_type:'refresh_token',refresh_token:'nwx_refresh_'+('A'.repeat(44)),
      ...fields,
    })),(error:unknown)=>error instanceof McpOAuthError);
  }
  assert.equal(touched,0);
});


test('issuer accepts both valid refresh scope orders from a trusted atomic authority',async()=>{
  const store=new MemoryMcpOAuthStore();
  const service=new McpOAuthService(store,{
    issuer:'https://mcp-issuer.invalid',resource,now:()=>at,
    refreshMode:'epoch-atomic',
    epochAccessVerifier:denyAccess,
    epochAtomicRefresh:{
      async rotate(){
        return {
          access_token:'nwx_mcp_'+('X'.repeat(44)),
          refresh_token:'nwx_refresh_'+('Y'.repeat(44)),
          token_type:'Bearer',expires_in:3600,
          scope:'offline_access mcp',
        };
      },
    },
  });
  const grant=await service.token(new URLSearchParams({
    grant_type:'refresh_token',
    refresh_token:'nwx_refresh_'+('Z'.repeat(44)),
    client_id:client,resource,
  }));
  assert.equal(grant.scope,'offline_access mcp');
  // The delegated authority is the only possible issuer in strict mode.
  assert.equal((await store.getRefreshToken(digest('nwx_refresh_'+('Z'.repeat(44))))),null);
});
