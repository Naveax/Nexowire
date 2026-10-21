/**
 * S5 #15 explicit opt-in, one bounded fixed-seed localhost source benchmark.
 * Never offers a host argument, never touches paid services or native Agents.
 */
import {freemem,cpus,totalmem} from 'node:os';
import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {runS5RealParserSeeded} from './bench-s5-real-598-seeded.js';
import {NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES} from '../src/mcp/http-app.js';

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--ack-local-4x9_5mib-source-only')
    throw Error('S5_EXPLICIT_LOCAL_SOURCE_APPROVAL_REQUIRED');
  if(freemem()<3*1024*1024*1024)throw Error('S5_MEMORY_PRECHECK_BLOCKED');
  const sourceHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(!/^[0-9a-f]{40}$/.test(sourceHead))throw Error('S5_SOURCE_SHA_MISSING');
  const filename=path.resolve('docs/reports/s5-598-real-parser-seeded-20261021.json');
  if(existsSync(filename))throw Error('S5_EVIDENCE_ALREADY_EXISTS');
  const startedUtc=new Date().toISOString();
  const result=await runS5RealParserSeeded({
    bodyBytes:NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,rssGrowthLimitBytes:256*1024*1024,
  });
  const record={
    class:'REAL_598_EXPRESS_PARSER_LOCAL_ONLY_NOT_NATIVE',
    sourceHead,startedUtc,completedUtc:new Date().toISOString(),
    host:{platform:process.platform,node:process.version,
      cpuModel:cpus()[0]?.model,totalMemoryBytes:totalmem()},
    limits:{largeConcurrent:4,bodyBytesEach:NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,
      rssGrowthStopBytes:256*1024*1024,freeRamPrecheckBytes:3*1024*1024*1024},
    result,
    percentileProvenance:{
      boundary:'performance.now before localhost HTTP request until full response body consumed',
      method:'nearest-rank sorted ceil(p*N)-1',smallSuccessN:20,largeSuccessN:4,
      excluded:'busy/gzip 503, gzip 413, cancelled or failed requests',
      caveat:'one local process/host only; CPU/RSS nondeterministic; do not infer provider SLO',
    },
    tenantProviderCounters:null,cloudflareD1DurableObjectsInvoice:null,
    nativeWssSuccessful:0,nativeToolCompletionsVerified:0,
    physicalOneGiBCrossDeviceTransfer:false,continuous24hSoak:false,
    productionDecision:'NO_GO',
  };
  mkdirSync(path.dirname(filename),{recursive:true});
  writeFileSync(filename,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({path:filename,sourceHead,result},null,2)+'\n');
}
void main().catch(error=>{
  process.stderr.write('S5_SEEDED_BENCH_STOP '+String(error)+'\n');
  process.exitCode=2;
});
