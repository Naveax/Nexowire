/**
 * One bounded LOCAL socket churn measurement. Generates one immutable JSON artifact.
 * No external provider, no account metrics, no user OS tool operation.
 */
import {cpus,totalmem} from 'node:os';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {runS5ReconnectStorm} from './bench-s5-loopback-reconnect-storm.js';
async function main(){
  const codeSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(!/^[0-9a-f]{40}$/.test(codeSha))throw new Error('Cannot verify code source SHA');
  const cpuStart=process.cpuUsage(),rssStart=process.memoryUsage().rss;
  const result=await runS5ReconnectStorm({socketsPerRound:120,rounds:3,
    queueLimit:32,processingLimit:4});
  const measured=process.cpuUsage(cpuStart);
  const data={
    schema:'nexowire-s5-reconnect-loopback-v1',
    sourceSha:codeSha,atUtc:new Date().toISOString(),
    classification:'OBSERVED_LOCAL_WS_ONLY_NOT_STAGING_PROVIDER_OR_NATIVE',
    host:{cpu:cpus()[0]?.model,totalMemoryBytes:totalmem(),node:process.version},
    sockets:result,
    localProcess:{cpuUserMs:measured.user/1000,cpuSystemMs:measured.system/1000,
      rssStartBytes:rssStart,rssEndBytes:process.memoryUsage().rss},
    quota:{canonicalSqliteReservations:null,observed:false,
      fixtureIdempotentAdmittedIds:result.uniqueReservations},
    native:{reportedCompletions:0,verifiedCompletions:0,
      proof:'no native OS operation was invoked'},
    cloud:{workerRequests:null,d1RowsRead:null,d1RowsWritten:null,
      durableObjectRequests:null,durableObjectDurationGbSeconds:null,
      costUsd:null,observed:false},
    soak:{actual24hRun:false,productionAccepted:false},
  };
  const out=path.resolve('docs/reports/s5-reconnect-loopback-20261018.json');
  mkdirSync(path.dirname(out),{recursive:true});
  writeFileSync(out,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({file:out,sourceSha:codeSha,sockets:result},null,2)+'\n');
}
void main().catch(e=>{process.stderr.write(String(e)+'\n');process.exitCode=1});
