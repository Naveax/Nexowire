import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MemoryMcpOAuthStore} from '../src/product/memory-mcp-oauth-store.js';
import {McpOAuthService} from '../src/product/mcp-oauth.js';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {createFusedMcpAuthorizeChargeHandler} from '../src/product/fused-mcp-authorize-charge.js';

const issuer='https://auth.example.test';
const resource='https://mcp.example.test/mcp';
const redirectUri='https://chatgpt.com/oauth/callback/test';
const verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const challenge=createHash('sha256').update(verifier,'ascii').digest('base64url');

async function fixture() {
  let current=new Date('2026-10-15T12:00:00.000Z');
  const oauthStore=new MemoryMcpOAuthStore();
  const oauth=new McpOAuthService(oauthStore,{
    issuer,resource,now:()=>current,
  });
  const store=new MemoryControlPlaneStore();
  const service=new ControlPlaneService(store,{now:()=>current});
  await service.ensureAccount({id:'oauth-owner-account'});
  let reservations=0;
  const handler=createFusedMcpAuthorizeChargeHandler({
    authenticateService:async req=>req.headers.get('authorization')==='Bearer service-secret-for-test-0123456789',
    authenticateAccessToken:token=>oauth.authenticateAccessToken(token),
    store,
    chargeUsage:async req=>{
      reservations++;
      return service.chargeUsage(req);
    },
  });
  const registration=await oauth.registerClient({
    redirect_uris:[redirectUri],
    token_endpoint_auth_method:'none',
  }) as {client_id:string};
  async function mint(scope='mcp') {
    const authorization=new URL(await oauth.authorize(
      'oauth-owner-account',
      new URLSearchParams({
        response_type:'code',
        client_id:registration.client_id,
        redirect_uri:redirectUri,
        code_challenge:challenge,
        code_challenge_method:'S256',
        resource,scope,
      }),
    ));
    const code=authorization.searchParams.get('code');
    assert.ok(code);
    const token=await oauth.token(new URLSearchParams({
      grant_type:'authorization_code',
      code,
      client_id:registration.client_id,
      redirect_uri:redirectUri,
      code_verifier:verifier,
      resource,
    }));
    return token.access_token;
  }
  function request(accessToken:string,id:string):Request {
    return new Request('https://auth.example.test/api/v1/internal/mcp/authorize-charge',{
      method:'POST',headers:{
        'content-type':'application/json',
        authorization:'Bearer service-secret-for-test-0123456789',
      },
      body:JSON.stringify({
        accessToken,invocationId:id,toolName:'machine_health',
      }),
    });
  }
  return {
    oauth,service,handler,mint,request,
    advance(ms:number){current=new Date(current.getTime()+ms)},
    get reservations(){return reservations},
    oauthStore,
  };
}

test('real first-party PKCE OAuth access token can authorize exactly one quota reservation',async()=>{
  const f=await fixture();
  const token=await f.mint('mcp offline_access');
  assert.match(token,/^nwx_mcp_/);
  const result=await f.handler(f.request(token,'oauth-valid-invocation-0001'));
  assert.equal(result.status,200);
  const json=JSON.stringify(await result.json());
  assert.equal(json.includes(token),false);
  assert.equal(f.reservations,1);
  assert.equal((await f.service.dashboard({accountId:'oauth-owner-account',role:'user'})).usage.usedCredits,1);
  assert.equal((await f.handler(f.request(token,'oauth-valid-invocation-0001'))).status,409);
  assert.equal((await f.service.dashboard({accountId:'oauth-owner-account',role:'user'})).usage.usedCredits,1);
});

test('expired real OAuth access token is rejected before the quota ledger',async()=>{
  const f=await fixture();
  const token=await f.mint();
  f.advance(3601_000);
  const rejected=await f.handler(f.request(token,'oauth-expired-invocation-0002'));
  assert.equal(rejected.status,401);
  assert.equal(f.reservations,0);
});

test('real OAuth token without mcp scope is not a metering bypass',async()=>{
  const f=await fixture();
  // Issuance itself denies refresh-only scope; additionally, verify the
  // fused handler remains fail-closed against a corrupted token-store record.
  await assert.rejects(f.mint('offline_access'),/scope is not supported/);
  const token=await f.mint('mcp');
  const hash=createHash('sha256').update(token,'utf8').digest('hex');
  const persisted=await f.oauthStore.getAccessToken(hash);
  assert.ok(persisted);
  await f.oauthStore.putAccessToken({...persisted,scopes:['offline_access']});
  const rejected=await f.handler(f.request(token,'oauth-scope-denied-0003'));
  assert.equal(rejected.status,401);
  assert.equal(f.reservations,0);
});

test('real OAuth access token bound to another resource cannot be used to reserve credits',async()=>{
  const f=await fixture();
  const token=await f.mint();
  const wrongResource=new McpOAuthService(f.oauthStore,{
    issuer,resource:'https://other.example.test/mcp',
    now:()=>new Date('2026-10-15T12:00:00.000Z'),
  });
  assert.equal(await wrongResource.authenticateAccessToken(token),null);
  const untrusted=createFusedMcpAuthorizeChargeHandler({
    authenticateService:async()=>true,
    authenticateAccessToken:t=>wrongResource.authenticateAccessToken(t),
    store:new MemoryControlPlaneStore(),
    chargeUsage:args=>f.service.chargeUsage(args),
  });
  const denied=await untrusted(f.request(token,'oauth-cross-resource-0004'));
  assert.equal(denied.status,401);
  assert.equal(f.reservations,0);
});
