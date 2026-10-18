/**
 * Scale v2 S5 | DEV-only, bounded local owner quota database benchmark.
 *
 * It performs NO HTTP/MCP/Cloudflare/provider requests, opens no network
 * ports, and never executes a native tool. It does not prove 850k/day.
 *
 * Run: node --import tsx scripts/bench-s5-owner-quota-local.ts --requests=1000 --accounts=4
 */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {ProposedTrustedOwnerQuotaAuthority} from '../src/product/trusted-owner-quota-authority-proposal.js';

const MAX_REQUESTS=10_000;
const MAX_ACCOUNTS=50;
const FIXED_UTC=new Date('2026-10-17T10:00:00.000Z');
const FINGERPRINT=createHash('sha256').update('s5-staging-local-read-tool').digest('hex');
const SQL_FILE='test/fixtures/scale-v2-owner-shared-quota-dev.sql';
const INGRESS_SQL='test/fixtures/scale-v2-all-ingress-transport-staging.sql';

export interface LocalQuotaBenchmarkOptions{
  requests:number;
  accounts:number;
  replayChecks?:number;
}
export interface LocalQuotaBenchmarkResult{
  kind:'local-owner-sqlite-only';
  requests:number;
  accounts:number;
  accepted:number;
  rejected:number;
  replayDuplicate:number;
  ledgerRows:number;
  dailyUsed:number;
  wallMs:number;
  reservationsPerSecond:number;
  latencyMs:{p50:number;p95:number;p99:number;max:number};
  databaseBytes:number;
  walBytes:number;
  constraints:string[];
}
function checkedInteger(n:number,low:number,high:number,name:string){
  if(!Number.isSafeInteger(n)||n<low||n>high){
    throw new Error(name+' must be a safe integer '+low+'..'+high);
  }
}
function quantile(sorted:number[],fraction:number):number{
  const at=Math.ceil(sorted.length*fraction)-1;
  return Number(sorted[Math.max(0,at)]!.toFixed(4));
}
function accountId(n:number):string{
  return 'bench-account-'+String(n).padStart(5,'0');
}
function deviceId(n:number):string{
  return 'bench-device-'+String(n).padStart(5,'0');
}
function token(n:number):string{
  return 'bench-nonprod-token-'+String(n).padStart(5,'0');
}
function invocation(n:number):string{
  return 'bench-invocation-'+String(n).padStart(9,'0');
}
export async function runLocalOwnerQuotaBenchmark(
  options:LocalQuotaBenchmarkOptions,
):Promise<LocalQuotaBenchmarkResult>{
  checkedInteger(options.requests,1,MAX_REQUESTS,'requests');
  checkedInteger(options.accounts,1,MAX_ACCOUNTS,'accounts');
  if(options.accounts>options.requests)throw new Error('accounts exceed requests');
  const replayChecks=options.replayChecks??Math.min(10,options.requests);
  checkedInteger(replayChecks,0,100,'replayChecks');
  const directory=mkdtempSync(path.join(tmpdir(),'nexowire-s5-quota-local-'));
  const location=path.join(directory,'trusted-owner-test.sqlite');
  const connections:DatabaseSync[]=[];
  try{
    const first=new DatabaseSync(location);
    connections.push(first);
    first.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    first.exec([
      readFileSync(path.resolve(SQL_FILE),'utf8'),
      readFileSync(path.resolve(INGRESS_SQL),'utf8'),
    ].join('\n'));
    const second=new DatabaseSync(location);
    connections.push(second);
    second.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    for(let i=0;i<options.accounts;i++){
      first.prepare(
        'INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)',
      ).run(accountId(i),'custom',850000,1,1);
      first.prepare(
        'INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)',
      ).run(deviceId(i),accountId(i),1,'safe');
    }
    const authorizers=connections.map(db=>new ProposedTrustedOwnerQuotaAuthority(
      db,async bearer=>{
        const match=/^bench-nonprod-token-(\d{5})$/.exec(bearer);
        if(!match)return null;
        const index=Number(match[1]);
        if(!Number.isSafeInteger(index)||index>=options.accounts)return null;
        return {accountId:accountId(index),sessionGeneration:1};
      },
      ()=>FIXED_UTC,
    ));
    const latencies:number[]=[];
    let accepted=0,rejected=0,replayDuplicate=0;
    const started=performance.now();
    for(let i=0;i<options.requests;i++){
      const account=i%options.accounts;
      const begin=performance.now();
      const decision=await authorizers[i%authorizers.length]!.reserveLogicalTool({
        bearerToken:token(account),deviceId:deviceId(account),
        invocationId:invocation(i),toolFingerprint:FINGERPRINT,
        operationClass:'read',
      });
      latencies.push(performance.now()-begin);
      if(decision.status==='reserved')accepted++;
      else rejected++;
      assert.equal(decision.authorizesToolExecution,false);
    }
    const wallMs=performance.now()-started;
    for(let i=0;i<replayChecks;i++){
      const account=i%options.accounts;
      const decision=await authorizers[(i+1)%authorizers.length]!.reserveLogicalTool({
        bearerToken:token(account),deviceId:deviceId(account),
        invocationId:invocation(i),toolFingerprint:FINGERPRINT,
        operationClass:'read',
      });
      assert.equal(decision.status,'duplicate');
      assert.equal(decision.authorizesToolExecution,false);
      replayDuplicate++;
    }
    const ledgerRows=Number((first.prepare(
      'SELECT COUNT(*) AS n FROM proposed_owner_quota_invocations',
    ).get() as {n:number}).n);
    const dailyUsed=Number((first.prepare(
      'SELECT COALESCE(SUM(used),0) AS n FROM proposed_owner_quota_daily',
    ).get() as {n:number}).n);
    assert.equal(accepted,options.requests);
    assert.equal(rejected,0);
    assert.equal(ledgerRows,accepted);
    assert.equal(dailyUsed,accepted);
    latencies.sort((a,b)=>a-b);
    const size=statSync(location).size;
    const wal=location+'-wal';
    return {
      kind:'local-owner-sqlite-only',
      requests:options.requests,accounts:options.accounts,
      accepted,rejected,replayDuplicate,ledgerRows,dailyUsed,
      wallMs:Number(wallMs.toFixed(3)),
      reservationsPerSecond:Number((accepted/(wallMs/1000)).toFixed(2)),
      latencyMs:{
        p50:quantile(latencies,.5),p95:quantile(latencies,.95),
        p99:quantile(latencies,.99),max:quantile(latencies,1),
      },
      databaseBytes:size,walBytes:existsSync(wal)?statSync(wal).size:0,
      constraints:[
        'DEV SQLite only: 2 independent connections, interleaved calls, NOT simultaneous writers',
        'Synthetic first-party verifier and static day; NO actual OAuth or native OS action',
        'NO HTTP, WebSocket, TLS, Tailscale, OpenAI Secure MCP Tunnel or Cloudflare provider activity',
        'Throughput includes local synchronous disk writes and authentication stub only',
        'No 24h soak, 600/min provider validation, cloud cost or 850000 real call proof',
      ],
    };
  }finally{
    for(const db of connections.reverse())try{db.close()}catch{}
    rmSync(directory,{recursive:true,force:true});
  }
}
function parseOptions(args:string[]):LocalQuotaBenchmarkOptions{
  const options:{requests?:number;accounts?:number;replayChecks?:number}={};
  for(const arg of args){
    const match=/^--(requests|accounts|replayChecks)=(\d+)$/.exec(arg);
    if(!match)throw new Error('Unknown benchmark argument (no network flags): '+arg);
    const key=match[1] as keyof typeof options;
    if(options[key]!==undefined)throw new Error('Repeated argument: '+key);
    options[key]=Number(match[2]);
  }
  return {requests:options.requests??1000,accounts:options.accounts??4,
    replayChecks:options.replayChecks};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runLocalOwnerQuotaBenchmark(parseOptions(process.argv.slice(2)))
    .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'))
    .catch(error=>{process.stderr.write(String(error)+'\n');process.exitCode=1;});
}
