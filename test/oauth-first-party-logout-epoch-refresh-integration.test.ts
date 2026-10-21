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
import {McpOAuthService} from '../src/product/mcp-oauth.js';
import {FirstPartyMcpOAuthLogoutBoundary} from '../src/product/mcp-oauth-first-party-logout.js';
import {ProposedMcpOAuthSessionEpoch} from '../src/product/mcp-oauth-session-epoch-proposal.js';
import {ProposedMcpOAuthEpochAtomicRefresh} from '../src/product/mcp-oauth-atomic-epoch-refresh-proposal.js';

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
    const rotator=new ProposedMcpOAuthEpochAtomicRefresh({db,resource,now:()=>at});
    const rotate=(refresh:string)=>rotator.rotate({
      refreshToken:refresh,clientId:client,requestedResource:resource,
    });
    await assert.rejects(rotate(a.refresh),/OAuth refresh session epoch unavailable/);
    const unrelated=await rotate(b.refresh);
    assert.match(unrelated.access_token,/^nwx_mcp_/);
    assert.match(unrelated.refresh_token,/^nwx_refresh_/);
    const row=sqlite.prepare(
      'SELECT account_id FROM mcp_oauth_access_tokens WHERE token_hash=?'
    ).get(digest(unrelated.access_token)) as {account_id:string};
    assert.equal(row.account_id,ownerB);
  } finally {sqlite.close()}
});
