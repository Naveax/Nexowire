/**
 * This CLI physically transmits ~1.25 GiB of synthetic bytes over 127.0.0.1.
 * Never run automatically in CI. Requires deliberate --ack-local-large-streams.
 * No file/content API or Cloudflare endpoints are contacted.
 */
import {writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {freemem} from 'node:os';
import {runS5LocalStreamLoad,S5_LOCAL_221_KIB,S5_LOCAL_OVER_256_MIB,S5_LOCAL_1_GIB}
  from './bench-s5-bounded-stream-transfer.js';
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--ack-local-large-streams'){
    throw new Error('Not automatic. Supply --ack-local-large-streams for bounded 1-GiB local TCP benchmark');
  }
  if(freemem()<2*1024*1024*1024)throw new Error('Not enough free RAM for safe Work PC test');
  const sourceHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(!/^[a-f0-9]{40}$/.test(sourceHead))throw new Error('Unknown local code HEAD');
  const startUtc=new Date().toISOString();
  const benchmark=await runS5LocalStreamLoad({
    sizesBytes:[S5_LOCAL_221_KIB,S5_LOCAL_OVER_256_MIB,S5_LOCAL_1_GIB],
    maxConcurrent:2,
    chunkBytes:65536,deadlineMs:60000,maxRssGrowthBytes:128*1024*1024,
  });
  const result={
    schema:'S5_LOCAL_TCP_STREAM_E2E_V1',
    provenance:{sourceHead,startUtc,endedAtUtc:new Date().toISOString(),
      limitations:'No actual Nexowire Artifact Bridge, Agent File API, WSS, provider cloud or persistent file store'},
    stream:benchmark,
    physicalStagingStatus:'BLOCKED',
    actualArtifactApiLargeFilesVerified:false,
    actualAuthenticatedWss100Plus:false,
    nativeToolCompletionsVerified:0,
    continuous24HourSoakVerified:false,
    productionAcceptance:'NO_GO',
  };
  const file=path.resolve('docs/reports/s5-stream-loopback-20261020.json');
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({file,sourceHead,
    measurements:benchmark.samples.map(s=>({
      bytes:s.receivedBytes,seconds:s.elapsedMs/1000,throughputMiBps:s.throughputMiBps,
      rssGrowthPeakBytes:s.rssGrowthPeakBytes,
      senderSha256:s.senderSha256,receiverSha256:s.receiverSha256,
      backpressureEvents:s.backpressureEvents,
      maxWritableBytes:s.maxSocketWritableLengthBytes,
    }))},null,2)+'\n');
}
void main().catch(error=>{process.stderr.write('S5 bounded test BLOCKED/FAIL: '+String(error)+'\n');process.exitCode=2});
