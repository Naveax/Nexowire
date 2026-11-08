import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ArtifactBridgeStore} from '../../../src/workspace/artifact-bridge.js';
import {ingestDeviceArtifact,type ArtifactSourceOps}
  from '../../../src/mcp/artifact-bridge-device-ingest.js';
import {quoteS5Cost,S5_ASSUMPTION_DEFAULTS}
  from '../../../src/ops/scale-s5-cost-envelope.js';
import {summarizeS5ScenarioResults}
  from '../../../scripts/report-s5-measured-scenarios.js';
import type {S5LoadResult}
  from '../../../scripts/bench-s5-loopback-ws-capacity.js';

const scope={accountId:'account:test',projectId:'Nexowire',deviceId:'k18-p006-local'};

test('T-638 #588 local artifact COMPLETE leaves external/physical acceptance pending',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'k18-p006-ingest-'));
  try{
    const content=Buffer.alloc(225_281,0x46);
    const hash=createHash('sha256').update(content).digest('hex');
    const source:ArtifactSourceOps={
      stat:async()=>({type:'file',size:content.length}),
      sha256:async()=>hash,
      read:async(_,offset,count)=>{
        const part=content.subarray(offset,offset+count);
        return {sourceBytes:content.length,offsetBytes:offset,
          bytesRead:part.length,contentBase64:part.toString('base64')};
      },
    };
    const artifactPath='k18/p006-local-only.bin';
    const store=new ArtifactBridgeStore(directory);
    const result=await ingestDeviceArtifact(store,source,{
      scope,sourcePath:'C:\\offline-fixture\\225KiB.bin',artifactPath,
      repository:'Naveax/Nexowire',commitSha:'2'.repeat(40),
      producerOperationId:'k18-p006-synthetic-only',testStatus:'unverified',
      acceptanceStatus:'pending',maxChunks:16,
    });
    assert.equal(result.state,'COMPLETE');
    assert.equal(result.sha256,hash);
    const manifest=await store.get(scope,artifactPath);
    assert.equal(manifest?.sha256,hash);
    assert.equal(manifest?.testStatus,'unverified');
    assert.equal(manifest?.acceptanceStatus,'pending');
    // No Agent/Hub, live file path, provider, network or hardware was used.
    const quote=quoteS5Cost(S5_ASSUMPTION_DEFAULTS);
    assert.equal(quote.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
    assert.equal(quote.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
  }finally{await fs.rm(directory,{recursive:true,force:true})}
});

function localResult():S5LoadResult{
  return {kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE',clients:256,
    mode:'isolated',callsPerClient:1,
    sockets:{connected:256,peak:256,closed:256},
    rpc:{attempted:256,reserved:256,duplicate:0,rateLimited:0,
      backpressure:0,other:0,peakInFlight:1,peakQueue:1,perSecond:1},
    latencyMs:{p50:2,p95:50,p99:120,max:130},
    cpuMs:{user:1,system:0},
    memoryBytes:{rssStart:2048,rssPeak:4096,rssEnd:4096},
    ioBytes:{sqlite:1024,wal:0,received:500,sent:500},
    fairness:{jainIndex:1,minUserSuccess:1,maxUserSuccess:1},
    ledger:{rows:256,dailyUsed:256,toolExecutions:0},
    elapsedMs:1000,constraints:['SYNTHETIC_LOOPBACK_ONLY']};
}

test('T-639 #539 p50/p95/p99 and peak sockets cannot become hosted throughput',()=>{
  const summary=summarizeS5ScenarioResults([localResult()]);
  const quote=quoteS5Cost(S5_ASSUMPTION_DEFAULTS);
  assert.equal(summary.scenarios[0]?.p99Ms,120);
  assert.equal(summary.scenarios[0]?.peakSockets,256);
  assert.equal(summary.measurementClassification,'LOCAL_SYNTHETIC_ONLY');
  assert.equal(summary.capacityEstimate,null);
  assert.equal(summary.providerCapacityProven,false);
  assert.equal(quote.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
  assert.equal(quote.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
  assert.equal(quote.actualProviderBill,'UNKNOWN');
});

test('T-640 #487 #1135 positive sub-cent projection stays nonzero but hosted capacity UNKNOWN',()=>{
  const report=quoteS5Cost(S5_ASSUMPTION_DEFAULTS,{
    workerRequests:{amount:1e-10,per:1,unit:'request',currency:'USD',
      source:'SYNTHETIC_TEST_QUOTE_NOT_PROVIDER'},
  });
  const calculated=report.componentCosts.workerRequests;
  assert.equal(typeof calculated,'number');
  assert.ok(typeof calculated==='number'&&calculated>0&&calculated<0.005);
  assert.ok(typeof report.knownSubtotal==='number'&&report.knownSubtotal>0);
  assert.equal(report.modeledTotal,'UNKNOWN'); // missing other four rates
  assert.equal(report.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
  assert.equal(report.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
  assert.equal(report.actualProviderBill,'UNKNOWN');
  assert.equal(summarizeS5ScenarioResults([]).capacityEstimate,null);
});
