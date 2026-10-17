import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeLocalFirstFunnel,
  readOnlyLocalFirstFunnelPlan,
} from '../src/mcp/local-first-funnel-plan.js';

const node=JSON.stringify({
  BackendState:'Running',Self:{Online:true,DNSName:'very-private-pc.my-tailnet.ts.net.'},
  CurrentTailnet:{MagicDNSSuffix:'my-tailnet.ts.net'},
});
const configured=(port:string,active=true)=>JSON.stringify({
  TCP:{'443':{HTTPS:true}},
  Web:{'very-private-pc.my-tailnet.ts.net:443':{
    Handlers:{'/':{Proxy:'http://127.0.0.1:'+port}},
  }},
  AllowFunnel:{'very-private-pc.my-tailnet.ts.net:443':active},
});

test('detects active public Hub 43110 route as migration-needed, never auto switches',()=>{
  const plan=analyzeLocalFirstFunnel(node,configured('43110'));
  assert.equal(plan.state,'needs-migration');
  assert.equal(plan.currentPublicHubDirectRoutes,1);
  assert.equal(plan.currentPublicProtectedIngressRoutes,0);
  assert.equal(plan.currentPublicRouteCount,1);
  assert.equal(plan.requiresStagedMigration,true);
  assert.equal(plan.readyToExpose,false);
  assert.deepEqual(Object.keys(plan).includes('dnsName'),false);
  assert.doesNotMatch(JSON.stringify(plan),/very-private-pc|my-tailnet/);
});

test('safe 43111 origin route is only labeled origin-ready, not globally accepted',()=>{
  const plan=analyzeLocalFirstFunnel(node,configured('43111'));
  assert.equal(plan.state,'origin-ready');
  assert.equal(plan.currentPublicProtectedIngressRoutes,1);
  assert.equal(plan.readyToExpose,false);
});

test('inactive private Serve is not treated as publicly exposed Funnel',()=>{
  const plan=analyzeLocalFirstFunnel(node,configured('43110',false));
  assert.equal(plan.state,'no-tunnel');
  assert.equal(plan.currentPublicHubDirectRoutes,0);
});

test('disconnected Tailscale blocks any route migration',()=>{
  const status=JSON.stringify({
    BackendState:'Stopped',Self:{Online:false,DNSName:'pc.ts.net'},
    CurrentTailnet:{MagicDNSSuffix:'ts.net'},
  });
  const plan=analyzeLocalFirstFunnel(status,configured('43110'));
  assert.equal(plan.state,'not-connected');
  assert.equal(plan.readyToExpose,false);
});

test('unknown published origin or route path fails closed',()=>{
  for(const url of [
    'http://169.254.169.254:43111','https://evil.example',
    'http://127.0.0.1:8080','http://127.0.0.1:43111/agent',
    'http://username:password@127.0.0.1:43111',
  ]){
    const snapshot=JSON.stringify({
      Web:{'pc.ts.net:443':{Handlers:{'/':{Proxy:url}}}},
      TCP:{},AllowFunnel:{'pc.ts.net:443':true},
    });
    const plan=analyzeLocalFirstFunnel(node,snapshot);
    assert.equal(plan.state,'blocked',url);
    assert.equal(plan.unknownPublicRoutes,1);
    assert.equal(plan.readyToExpose,false);
  }
  const path=JSON.stringify({
    Web:{'pc.ts.net:443':{Handlers:{'/agent':{Proxy:'http://127.0.0.1:43111'}}}},
    TCP:{},AllowFunnel:{'pc.ts.net:443':true},
  });
  assert.equal(analyzeLocalFirstFunnel(node,path).state,'blocked');
});

test('unrecognized format and JSON errors never return permissive readiness',()=>{
  for(const x of ['{}','null','[]','{"Web":[]}','{"Web":{},"BadField":"x"}','invalid']){
    assert.throws(()=>analyzeLocalFirstFunnel(node,x));
  }
  assert.throws(()=>analyzeLocalFirstFunnel('invalid',configured('43111')));
});

test('raw TCP public forwarding is flagged rather than mistaken for safe MCP HTTPS',()=>{
  const snapshot=JSON.stringify({
    Web:{},TCP:{'443':{TCPForward:'127.0.0.1:43110'}},
    AllowFunnel:{'pc.ts.net:443':true},
  });
  const plan=analyzeLocalFirstFunnel(node,snapshot);
  assert.equal(plan.state,'blocked');
  assert.equal(plan.unknownPublicRoutes,1);
  assert.equal(plan.readyToExpose,false);
});

test('read-only collector calls status and funnel status and never set/reset',async()=>{
  const calls:string[]=[];
  const plan=await readOnlyLocalFirstFunnelPlan(async args=>{
    calls.push(args.join(' '));
    if(args[0]==='status')return node;
    if(args[0]==='funnel' && args[1]==='status')return configured('43110');
    throw new Error('Unexpected external process call');
  });
  assert.deepEqual(calls,['status --json','funnel status --json']);
  assert.equal(plan.currentPublicHubDirectRoutes,1);
});

test('read-only collector fails closed if provider query fails',async()=>{
  await assert.rejects(readOnlyLocalFirstFunnelPlan(async()=>{
    throw new Error('Tailscale provider offline');
  }),/provider offline/);
});
