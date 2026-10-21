import test from 'node:test';
import assert from 'node:assert/strict';
import { FirstPartyMcpOAuthLogoutBoundary } from '../src/product/mcp-oauth-first-party-logout.js';
import type {
  ProposedOAuthSessionEpochDecision,
} from '../src/product/mcp-oauth-session-epoch-proposal.js';

test('first-party owner logout rejects MCP bearer, foreign owner and service impersonation',async()=>{
  let transitions=0;
  const boundary=new FirstPartyMcpOAuthLogoutBoundary({
    verifyFirstPartyOwnerSession:async proof=>{
      if(proof==='SIGNED_FIRST_PARTY_OWNER_A_SESSION') return {accountId:'owner-a',role:'user'};
      if(proof==='SIGNED_FIRST_PARTY_OWNER_B_SESSION') return {accountId:'owner-b',role:'admin'};
      if(proof==='SIGNED_FIRST_PARTY_SERVICE_SESSION') return {accountId:'owner-a',role:'service'};
      return null;
    },
    epoch:{
      transition:async input=>{
        transitions++;
        assert.equal(input.authenticatedAccountId,input.targetAccountId);
        assert.equal(input.kind,'logout');
        return {status:'transitioned',state:{generation:4,locked:true}};
      },
    },
  });
  const run=(proof:string,target='owner-a')=>boundary.logout({
    firstPartySessionProof:proof,targetAccountId:target,
    operationId:'synthetic-logout-0001',
  });
  assert.deepEqual(await run('nwx_mcp_'+'x'.repeat(50)),{status:'denied'});
  assert.deepEqual(await run('nwx_refresh_'+'x'.repeat(50)),{status:'denied'});
  assert.deepEqual(await run('SIGNED_FIRST_PARTY_OWNER_B_SESSION'),{status:'denied'});
  assert.deepEqual(await run('SIGNED_FIRST_PARTY_SERVICE_SESSION'),{status:'denied'});
  assert.equal(transitions,0);
  const yes=await run('SIGNED_FIRST_PARTY_OWNER_A_SESSION');
  assert.deepEqual(yes,{status:'transitioned',state:{generation:4,locked:true}});
  assert.equal(transitions,1);
});

test('first-party logout adapter fails closed on verifier errors and never treats access-only revocation as logout',async()=>{
  let changes=0;
  const boundary=new FirstPartyMcpOAuthLogoutBoundary({
    verifyFirstPartyOwnerSession:async proof=>{
      if(proof==='SIGNED_FIRST_PARTY_OWNER_SESSION') throw Error('upstream secret diagnostic');
      return null;
    },
    epoch:{transition:async ():Promise<ProposedOAuthSessionEpochDecision>=>{
      changes++;
      return {status:'denied'};
    }},
  });
  await assert.rejects(boundary.logout({
    firstPartySessionProof:'SIGNED_FIRST_PARTY_OWNER_SESSION',
    targetAccountId:'owner-1',operationId:'logout-gate-unavailable',
  }),/OAUTH_FIRST_PARTY_OWNER_UNAVAILABLE/);
  assert.equal(changes,0);
});
