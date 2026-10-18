import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProposedOutboundQuotaWsClient,startProposedOwnerQuotaOutboundWsHub,
  type OutboundQuotaFrame,
} from '../src/product/owner-quota-outbound-ws-proposal.js';

const decision={
  status:'reserved',
  dayUtc:'2026-10-17',
  dailyLimit:100,
  used:1,
  remaining:99,
  authorizesToolExecution:false,
};
const proto:OutboundQuotaFrame={
  version:1,kind:'reserve',requestId:'owner-response-test-0000',
  // This is a transport-only fixture. The fake HTTP response ensures that
  // no real account, device key, owner RPC or quota is ever used.
  envelope:{} as OutboundQuotaFrame['envelope'],
};

async function mockOwnerBridge(
  response:()=>{status:number;body:unknown},
){
  const hub=await startProposedOwnerQuotaOutboundWsHub({
    trustedOwnerRpcOrigin:'http://127.0.0.1:43123/internal/owner-quota/v1/reserve',
    fetchImpl:async()=> {
      const next=response();
      return new Response(JSON.stringify(next.body),{
        status:next.status,headers:{'content-type':'application/json'},
      });
    },
  });
  const client=new ProposedOutboundQuotaWsClient(hub.url);
  let n=0;
  return {
    async send(){
      const id='owner-response-test-'+String(++n).padStart(4,'0');
      return client.reserve({...proto,requestId:id});
    },
    async close(){client.close();await hub.close()},
  };
}

test('malformed HTTP 200 owner decisions fail closed before reaching the WSS client',
  {timeout:15000},async()=>{
    const invalid:unknown[]=[
      null,{error:'not_authorized'},{decision:null},
      {decision:{...decision,authorizesToolExecution:true}},
      {decision:{...decision,remaining:100}},
      {decision:{...decision,used:-1}},
      {decision:{...decision,dailyLimit:1.5}},
      {decision:{...decision,status:'granted'}},
      {decision:{...decision,dayUtc:'yesterday'}},
      {decision:{...decision,toolExecutionAllowed:true}},
      {decision:{...decision,authorizesToolExecution:'false'}},
    ];
    let current:unknown;
    const x=await mockOwnerBridge(()=>({status:200,body:current}));
    try{
      for(const fake of invalid){
        current=fake;
        const result=await x.send();
        assert.equal(result.httpStatus,502);
        assert.deepEqual(result.data,{error:'owner_rpc_invalid_decision'});
      }
    }finally{await x.close()}
  });

test('well-formed owner admission remains valid but never grants OS execution',
  {timeout:15000},async()=>{
    let status='reserved';
    const x=await mockOwnerBridge(()=>({
      status:200,body:{decision:{...decision,status}},
    }));
    try{
      for(const expected of ['reserved','duplicate','unauthorized','daily-exhausted']){
        status=expected;
        const result=await x.send();
        assert.equal(result.httpStatus,200);
        assert.equal((result.data as {decision:{status:string}}).decision.status,expected);
        assert.equal((result.data as {decision:{authorizesToolExecution:boolean}})
          .decision.authorizesToolExecution,false);
      }
    }finally{await x.close()}
  });

test('non-200 owner HTTP errors keep their distinct failed status, not a fake success',
  {timeout:15000},async()=>{
    const x=await mockOwnerBridge(()=>({
      status:409,body:{error:'device_nonce_replayed'},
    }));
    try{
      const result=await x.send();
      assert.equal(result.httpStatus,409);
      assert.deepEqual(result.data,{error:'device_nonce_replayed'});
    }finally{await x.close()}
  });
