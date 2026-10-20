/**
 * Opt-in LOCAL 4 x 9.5 MiB HTTP fixture measurement, not production MCP.
 * Memory-only ephemeral 127.0.0.1 sockets; no external target arg.
 */
import {cpus,freemem,totalmem} from 'node:os';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {runS5LocalHttpIsolation,S5_HTTP_MAX_BYTES} from './bench-s5-http-mcp-isolation.js';

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--ack-38mib-loopback'){
    throw new Error('Explicit --ack-38mib-loopback required; no automatic/CI heavy HTTP workload');
  }
  if(freemem()<3*1024*1024*1024)throw new Error('Preflight BLOCKED: low free memory');
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(!/^[a-f0-9]{40}$/.test(head))throw new Error('Cannot pin source commit');
  const startedUtc=new Date().toISOString();
  const result=await runS5LocalHttpIsolation({
    largeRequests:4,largeRequestBytes:S5_HTTP_MAX_BYTES,smallRequests:20,
    probeFifthRequest:true,probeOverLimit:true,perChunkPauseMs:1,
    runLimitMs:45000,rssGrowthBudgetBytes:128*1024*1024,
  });
  const evidence={
    kind:'S5_4X_9_5MIB_HTTP_LOOPBACK_NO_MCP_PRODUCTION_PARSER',
    sourceHead:head,startedUtc,completedUtc:new Date().toISOString(),
    host:{platform:process.platform,node:process.version,cpuModel:cpus()[0]?.model,
      totalMemoryBytes:totalmem()},
    fixture:result,
    maxHttpResponseBytes:'fixture only, no deployed parser exercised',
    cloudflareWorkersD1DoActualCost:null,
    externalAuthenticatedWssConnections:0,
    verifiedNativeToolCompletions:0,
    actual24hSoak:false,
    stagingAcceptance:'BLOCKED',
    productionAcceptance:'NO_GO',
  };
  const f=path.resolve('docs/reports/s5-http-9-5mib-loopback-20261020.json');
  if(existsSync(f))throw new Error('Evidence file already exists, do not overwrite');
  mkdirSync(path.dirname(f),{recursive:true});
  writeFileSync(f,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({path:f,head,result},null,2)+'\n');
}
void main().catch(e=>{process.stderr.write('S5 HTTP fixture stop: '+String(e)+'\n');process.exitCode=2});
