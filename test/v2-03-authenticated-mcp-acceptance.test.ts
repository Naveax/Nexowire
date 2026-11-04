import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {verifyConnectionV2AuthenticatedReadOnly} from '../src/mcp/cloudflare-connection-doctor.js';

const TOKEN='disposable_token_no_real_authority_123';
const MARKER='v1-contract-expected-marker';
type Mode='healthy'|'wrong-resource'|'wrong-issuer'|'revoked'|'expired'|
  'wrong-output'|'sse-half-open'|'tool-not-listed'|'session-swap';
async function fixture(t:TestContext,mode:Mode='healthy'){
  const requests:Array<{path:string;method:string;authorized:boolean;session?:string}>=[];
  let server:Server;
  server=createServer(async(req,res)=>{
    const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    const metadataUrl=base+'/.well-known/oauth-protected-resource/mcp';
    const resource=base+'/mcp';
    const sendJson=(value:unknown,code=200,session=false)=>{
      res.writeHead(code,{'content-type':'application/json',
        ...(session?{'mcp-session-id':'session_0001'}:{})});
      res.end(JSON.stringify(value));
    };
    const url=req.url??'';
    if(req.method==='GET'&&url==='/.well-known/oauth-protected-resource/mcp'){
      sendJson({resource:mode==='wrong-resource'?'https://elsewhere.example.test/mcp':resource,
        authorization_servers:[mode==='wrong-issuer'?'https://forged.example.test':'https://issuer.example.test']});
      return;
    }
    if(req.method!=='POST'||url!=='/mcp'){res.writeHead(404);res.end();return;}
    let text='';
    for await(const chunk of req){text+=String(chunk);if(text.length>4096){res.destroy();return;}}
    let rpc:{id:number;method:string;params?:unknown};
    try{rpc=JSON.parse(text);}catch{res.writeHead(400);res.end();return;}
    const authorized=req.headers.authorization==='Bearer '+TOKEN;
    requests.push({path:url,method:rpc.method,authorized,session:req.headers['mcp-session-id'] as string|undefined});
    if(!authorized||mode==='revoked'||mode==='expired'){
      res.writeHead(401,{'www-authenticate':'Bearer resource_metadata="'+metadataUrl+'", scope="mcp"'});
      res.end();return;
    }
    const success=(result:unknown)=>({jsonrpc:'2.0',id:rpc.id,result});
    if(rpc.method==='initialize'){
      sendJson(success({protocolVersion:'2025-03-26',
        capabilities:{tools:{}},serverInfo:{name:'nexowire',version:'0.1.0'}}),200,true);
      return;
    }
    if(rpc.method==='tools/list'){
      res.writeHead(200,{'content-type':'text/event-stream',
        'mcp-session-id':mode==='session-swap'?'other_session':'session_0001'});
      res.end('event: message\nid: fixture-event\ndata: '+JSON.stringify(success({
        tools:mode==='tool-not-listed'?[]:[{name:'nexowire_surface_info',
          description:'read-only metadata',annotations:{readOnlyHint:true}}],
      }))+'\n\n');
      return;
    }
    if(rpc.method==='tools/call'){
      if(mode==='sse-half-open'){
        res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':'session_0001'});
        res.write(': keepalive\n\n');
        return;
      }
      sendJson(success({isError:false,content:[{type:'text',text:mode==='wrong-output'?
        'a wrong or incomplete reply':'{"mcpSurfaceVersion":"'+MARKER+'"}'}]}),200,true);
      return;
    }
    sendJson({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'unexpected method'}});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const resourceUrl='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/mcp';
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  const run=(overrides:Partial<Parameters<typeof verifyConnectionV2AuthenticatedReadOnly>[0]>={})=>
    verifyConnectionV2AuthenticatedReadOnly({
      resourceUrl,issuerUrl:'https://issuer.example.test',
      bearerToken:TOKEN,expectedOutputContains:MARKER,
      allowLoopbackHttpFixture:true,timeoutMs:1000,...overrides,
    });
  return {run,requests,resourceUrl};
}
test('V2-03 real loopback HTTP+SSE read-only protocol: initialize, session, list, matching completed tool',async t=>{
  const f=await fixture(t);
  const result=await f.run();
  assert.equal(result.stage,'AUTHENTICATED_MCP_READY');
  assert.equal(result.authenticatedToolVerified,true);
  assert.equal(result.publicBoundaryVerified,true);
  assert.equal(result.sessionIdObserved,true);
  assert.deepEqual(result.completedSteps,
    ['metadata','oauth_challenge','initialize','tools_list','tools_call_completed']);
  assert.deepEqual(f.requests.map(x=>[x.method,x.authorized]),[
    ['initialize',false],['initialize',true],['tools/list',true],['tools/call',true],
  ]);
  assert.deepEqual(f.requests.slice(2).map(x=>x.session),['session_0001','session_0001']);
});
test('V2-03 issuer/audience confusion never reaches authenticated tool completion',async t=>{
  for(const mode of ['wrong-resource','wrong-issuer'] as const){
    await t.test(mode,async sub=>{
      const f=await fixture(sub,mode);
      const result=await f.run();
      assert.equal(result.stage,'DEGRADED');
      assert.equal(result.authenticatedToolVerified,false);
      assert.equal(result.code,'MCP_OAUTH_RESOURCE_OR_ISSUER_MISMATCH');
      assert.equal(f.requests.length,0);
    });
  }
});
test('V2-03 revoked and expired device/owner token cannot report authenticated readiness',async t=>{
  for(const mode of ['revoked','expired'] as const){
    await t.test(mode,async sub=>{
      const f=await fixture(sub,mode);
      const result=await f.run();
      assert.equal(result.stage,'DEGRADED');
      assert.equal(result.code,'MCP_AUTHENTICATED_HTTP_401');
      assert.equal(result.authenticatedToolVerified,false);
      assert.ok(!f.requests.some(x=>x.method==='tools/call'));
    });
  }
});
test('V2-03 incomplete output, absent tool, or changed session must fail closed',async t=>{
  for(const [mode,code] of [['wrong-output','MCP_READ_ONLY_OUTPUT_MISMATCH'],
    ['tool-not-listed','MCP_READ_ONLY_TOOL_NOT_ADVERTISED'],
    ['session-swap','MCP_SESSION_ID_INVALID']] as const){
    await t.test(mode,async sub=>{
      const f=await fixture(sub,mode);
      const result=await f.run();
      assert.equal(result.stage,'DEGRADED');
      assert.equal(result.code,code);
      assert.equal(result.authenticatedToolVerified,false);
    });
  }
});
test('V2-03 half-open streaming response times out without replaying tools/call',async t=>{
  const f=await fixture(t,'sse-half-open');
  const result=await f.run({timeoutMs:250});
  assert.equal(result.stage,'DEGRADED');
  assert.equal(result.code,'MCP_TIMEOUT_OR_CANCELLED');
  assert.equal(result.authenticatedToolVerified,false);
  assert.equal(f.requests.filter(r=>r.method==='tools/call').length,1);
});
test('V2-03 public staging verifier refuses plaintext and mutation tool selection',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({allowLoopbackHttpFixture:false}),/STAGING_RESOURCE_INVALID/);
  await assert.rejects(f.run({toolName:'file_write' as never}),/STAGING_TOOL_NOT_READ_ONLY/);
  assert.equal(f.requests.length,0);
});
test('V2-03 hub disconnect before metadata is UNAVAILABLE, no false ready',async t=>{
  const f=await fixture(t);
  const url=f.resourceUrl;
  const result=await f.run({fetchImpl:async()=>{throw Error('socket closed before response');}});
  assert.equal(result.stage,'UNAVAILABLE');
  assert.equal(result.authenticatedToolVerified,false);
  assert.deepEqual(result.completedSteps,[]);
  assert.ok(url.includes('/mcp'));
});
