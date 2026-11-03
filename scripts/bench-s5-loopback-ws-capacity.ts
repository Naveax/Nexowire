/**
 * S5 bounded loopback WebSocket fixture. No TLS/Cloudflare/MCP/native dispatch.
 * Synthetic users are NOT authenticated customers and reservations are NOT tool completions.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {setImmediate as nextTurn,setTimeout as sleep} from 'node:timers/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {ProposedAllIngressTransportMeter} from '../src/mcp/all-ingress-transport-meter-proposal.js';
import {ProposedTrustedOwnerQuotaAuthority} from '../src/product/trusted-owner-quota-authority-proposal.js';

const FINGERPRINT=createHash('sha256').update('s5-fixture-read-only').digest('hex');
const AT=new Date('2026-10-18T12:00:00.000Z');
const SCOPE='synthetic-operator-ingress-1';
const account=(i:number)=>'synthetic-account-'+String(i).padStart(4,'0');
const device=(i:number)=>'synthetic-device-'+String(i).padStart(4,'0');
const token=(i:number)=>'synthetic-fixture-bearer-'+String(i).padStart(4,'0');
/** Nearest-rank percentiles for actual, strictly positive local timings only.
 * Empty/invalid observations must not silently become a zero-latency PASS. */
export function summarizeS5Latencies(samples:readonly number[]):
  {p50:number;p95:number;p99:number;max:number}{
  if(samples.length===0||samples.some(x=>!Number.isFinite(x)||x<=0)){
    throw new Error('S5 latency samples must be non-empty finite positive durations');
  }
  const sorted=[...samples].sort((a,b)=>a-b);
  // Positive observations below 0.0005 ms must not be rounded into a false zero.
  const at=(p:number)=>Math.max(.001,Number(sorted[Math.ceil(sorted.length*p)-1]!.toFixed(3)));
  return {p50:at(.5),p95:at(.95),p99:at(.99),max:at(1)};
}
function integer(n:number,min:number,max:number,name:string):void{
  if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(name+' outside '+min+'..'+max);
}
export interface S5LoadOptions{
  clients:number;
  callsPerClient?:number;
  mode?:'isolated'|'shared';
  maxInFlight?:number;
  queueCap?:number;
  minuteLimit?:number;
  dailyLimit?:number;
}
export interface S5LoadResult{
  kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE';
  clients:number;mode:'isolated'|'shared';callsPerClient:number;
  sockets:{connected:number;peak:number;closed:number};
  rpc:{attempted:number;reserved:number;duplicate:number;rateLimited:number;backpressure:number;other:number;peakInFlight:number;peakQueue:number;perSecond:number};
  latencyMs:{p50:number;p95:number;p99:number;max:number};
  cpuMs:{user:number;system:number};memoryBytes:{rssStart:number;rssPeak:number;rssEnd:number};
  ioBytes:{sqlite:number;wal:number;received:number;sent:number};
  fairness:{jainIndex:number;minUserSuccess:number;maxUserSuccess:number};
  ledger:{rows:number;dailyUsed:number;toolExecutions:0};
  elapsedMs:number;constraints:string[];
}
type Packet={client:number;id:string;reply:string};
type Reply={status:string;authorizesToolExecution?:boolean};
export async function runS5LoopbackLoad(opts:S5LoadOptions):Promise<S5LoadResult>{
  integer(opts.clients,1,256,'clients');
  const calls=opts.callsPerClient??2, mode=opts.mode??'isolated';
  const maxInFlight=opts.maxInFlight??8,queueCap=opts.queueCap??256;
  const minuteLimit=opts.minuteLimit??600,dailyLimit=opts.dailyLimit??850000;
  integer(calls,1,4,'callsPerClient');
  integer(maxInFlight,1,16,'maxInFlight');
  integer(queueCap,1,256,'queueCap');
  integer(minuteLimit,1,600,'minuteLimit');
  integer(dailyLimit,1,850000,'dailyLimit');
  if(mode!=='isolated'&&mode!=='shared')throw new Error('Invalid mode');
  if(opts.clients*calls>1024)throw new Error('Bounded request budget exceeded');
  const folder=mkdtempSync(path.join(tmpdir(),'nexowire-s5-ws-'));
  const dbPath=path.join(folder,'load.sqlite');
  const db=new DatabaseSync(dbPath);
  let server:WebSocketServer|undefined;
  let pendingResult:S5LoadResult|undefined;
  const clients:WebSocket[]=[];
  const activeSockets=new Set<WebSocket>();
  let peakSockets=0,closed=0,inFlight=0,peakInFlight=0,peakQueue=0;
  let received=0,sent=0,backpressure=0,rateLimited=0,other=0,reserved=0,duplicate=0;
  let attempts=0;
  const latencies:number[]=[];
  const successful=new Array<number>(opts.clients).fill(0);
  const acceptedIds:Array<{client:number;n:number}>=[];
  const rssStart=process.memoryUsage().rss;
  let rssPeak=rssStart;
  const measure=()=>{rssPeak=Math.max(rssPeak,process.memoryUsage().rss)};
  const cpuStart=process.cpuUsage();
  const start=performance.now();
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    for(const f of ['test/fixtures/scale-v2-owner-shared-quota-dev.sql','test/fixtures/scale-v2-all-ingress-transport-staging.sql']){
      db.exec(readFileSync(path.resolve(f),'utf8'));
    }
    for(let i=0;i<(mode==='isolated'?opts.clients:1);i++){
      db.prepare('INSERT INTO proposed_owner_quota_accounts VALUES(?,?,?,?,?)')
        .run(account(i),'custom',dailyLimit,1,1);
    }
    for(let i=0;i<opts.clients;i++){
      db.prepare('INSERT INTO proposed_owner_quota_devices VALUES(?,?,?,?)')
        .run(device(i),account(mode==='isolated'?i:0),1,'safe');
    }
    const quota=new ProposedTrustedOwnerQuotaAuthority(db,async bearer=>{
      const matched=/^synthetic-fixture-bearer-(\d{4})$/.exec(bearer);
      if(!matched)return null;
      const i=Number(matched[1]);
      if(i>=opts.clients)return null;
      return {accountId:account(mode==='isolated'?i:0),sessionGeneration:1};
    },()=>AT);
    const meter=new ProposedAllIngressTransportMeter(db,minuteLimit);
    const queue:Array<{ws:WebSocket;packet:Packet}>=[];
    const response=(ws:WebSocket,reply:Reply)=>{
      if(ws.readyState===WebSocket.OPEN){
        const payload=JSON.stringify(reply);sent+=Buffer.byteLength(payload);ws.send(payload);
      }
    };
    const processQueue=()=>{
      while(inFlight<maxInFlight && queue.length){
        const job=queue.shift()!;inFlight++;peakInFlight=Math.max(peakInFlight,inFlight);
        void (async()=>{
          try{
            await nextTurn();
            const admitted=meter.observe(SCOPE,AT);
            if(!admitted.allowed){
              rateLimited++;
              response(job.ws,{status:'rate-limited',authorizesToolExecution:false});
              return;
            }
            const decision=await quota.reserveLogicalTool({
              bearerToken:token(job.packet.client),
              deviceId:device(job.packet.client),
              invocationId:job.packet.id,
              toolFingerprint:FINGERPRINT,
              operationClass:'read',
            });
            if(decision.authorizesToolExecution!==false)throw new Error('fixture unauthorized dispatch');
            if(decision.status==='reserved'){
              reserved++;successful[job.packet.client]!++;
              acceptedIds.push({client:job.packet.client,n:Number(job.packet.id.slice(-3))});
            }
            else if(decision.status==='duplicate')duplicate++;
            else other++;
            response(job.ws,{status:decision.status,authorizesToolExecution:false});
          }catch{
            other++;response(job.ws,{status:'error',authorizesToolExecution:false});
          }finally{
            inFlight--;measure();processQueue();
          }
        })();
      }
    };
    server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:1024,clientTracking:true});
    server.on('connection',ws=>{
      activeSockets.add(ws);peakSockets=Math.max(peakSockets,activeSockets.size);
      ws.on('close',()=>{activeSockets.delete(ws);closed++});
      ws.on('message',(data)=>{
        const raw=data.toString();received+=Buffer.byteLength(raw);attempts++;
        let packet:Packet;
        try{
          const parsed:unknown=JSON.parse(raw);
          if(!parsed||typeof parsed!=='object')throw new Error();
          const p=parsed as Partial<Packet>;
          if(typeof p.client!=='number'||!Number.isInteger(p.client)||p.client<0||
            p.client>=opts.clients||typeof p.id!=='string'||
            !/^synthetic-invocation-\d{4}-\d{3}$/.test(p.id))throw new Error();
          packet={client:p.client,id:p.id,reply:''};
        }catch{other++;response(ws,{status:'bad-request',authorizesToolExecution:false});return}
        if(queue.length>=queueCap){backpressure++;response(ws,{status:'backpressure',authorizesToolExecution:false});return}
        queue.push({ws,packet});peakQueue=Math.max(peakQueue,queue.length);
        processQueue();
      });
    });
    await new Promise<void>((resolve,reject)=>{
      if(server!.address()){resolve();return;}
      server!.once('listening',resolve);server!.once('error',reject);
    });
    const address=server.address();
    if(!address||typeof address==='string')throw new Error('Fixture needs ephemeral port');
    const url='ws://127.0.0.1:'+address.port;
    // Bounded batches avoid Windows socket accept/backlog bursts at 250+ clients.
    for(let base=0;base<opts.clients;base+=16){
      const batch:WebSocket[]=[];
      for(let i=base;i<Math.min(base+16,opts.clients);i++){
        const ws=new WebSocket(url,{perMessageDeflate:false,handshakeTimeout:5000});
        clients.push(ws);batch.push(ws);
      }
      await Promise.all(batch.map(ws=>new Promise<void>((resolve,reject)=>{
        if(ws.readyState===WebSocket.OPEN)return resolve();
        ws.once('open',resolve);ws.once('error',reject);
      })));
    }
    const request=async(ws:WebSocket,client:number,n:number)=>{
      const id='synthetic-invocation-'+String(client).padStart(4,'0')+'-'+String(n).padStart(3,'0');
      const started=performance.now();
      const result=await new Promise<Reply>((resolve,reject)=>{
        const timeout=setTimeout(()=>{ws.off('message',onMessage);reject(new Error('RPC timeout'))},30000);
        const onMessage=(data:WebSocket.RawData)=>{
          clearTimeout(timeout);resolve(JSON.parse(data.toString()) as Reply);
        };
        ws.once('message',onMessage);
        ws.send(JSON.stringify({client,id}));
      });
      latencies.push(performance.now()-started);
      assert.equal(result.authorizesToolExecution,false);
      return result.status;
    };
    // All sockets stay connected; at most 32 logical users have active RPCs.
    // Exceeding this client-side load generator bound requires a new acceptance plan.
    for(let base=0;base<clients.length;base+=32){
      await Promise.all(clients.slice(base,base+32).map(async(ws,j)=>{
        const i=base+j;
        for(let n=0;n<calls;n++)await request(ws,i,n);
      }));
    }
    // Replay ONLY committed logical IDs. Failed backpressure requests are not duplicates.
    const replayCount=Math.min(8,acceptedIds.length,Math.max(0,minuteLimit-attempts));
    for(const item of acceptedIds.slice(0,replayCount)){
      const result=await request(clients[item.client]!,item.client,item.n);
      assert.equal(result,'duplicate');
    }
    const ledgerRows=Number((db.prepare('SELECT COUNT(*) AS n FROM proposed_owner_quota_invocations').get() as {n:number}).n);
    const dailyUsed=Number((db.prepare('SELECT COALESCE(SUM(used),0) AS n FROM proposed_owner_quota_daily').get() as {n:number}).n);
    assert.equal(ledgerRows,reserved);
    assert.equal(dailyUsed,reserved);
    assert.equal(attempts,reserved+duplicate+rateLimited+backpressure+other);
    const elapsed=performance.now()-start;
    const cpu=process.cpuUsage(cpuStart);
    const successes=successful.reduce((a,b)=>a+b,0);
    const squares=successful.reduce((a,b)=>a+b*b,0);
    const fairness=squares===0?0:successes*successes/(opts.clients*squares);
    pendingResult={
      kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE',clients:opts.clients,mode,callsPerClient:calls,
      sockets:{connected:opts.clients,peak:peakSockets,closed},
      rpc:{attempted:attempts,reserved,duplicate,rateLimited,backpressure,other,
        peakInFlight,peakQueue,perSecond:Number((reserved/(elapsed/1000)).toFixed(2))},
      latencyMs:summarizeS5Latencies(latencies),
      cpuMs:{user:cpu.user/1000,system:cpu.system/1000},
      memoryBytes:{rssStart,rssPeak,rssEnd:process.memoryUsage().rss},
      ioBytes:{sqlite:statSync(dbPath).size,wal:existsSync(dbPath+'-wal')?statSync(dbPath+'-wal').size:0,
        received,sent},fairness:{jainIndex:Number(fairness.toFixed(5)),
        minUserSuccess:Math.min(...successful),maxUserSuccess:Math.max(...successful)},
      ledger:{rows:ledgerRows,dailyUsed,toolExecutions:0},elapsedMs:Number(elapsed.toFixed(2)),
      constraints:['loopback ws:// ONLY, not wss://, provider/Cloudflare or real MCP',
        'synthetic bearer verifier and static UTC clock, not OAuth or customer identity',
        'single event-loop SQLite writer; parallel network arrivals, NOT multi-process DB writes',
        'reservation is not tool execution; physical success=0; 24h soak NOT RUN'],
    };
    return pendingResult;
  }finally{
    for(const ws of clients)try{ws.terminate()}catch{}
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    // Server close callback can precede peer close events on loopback (notably Windows).
    // Do not publish a misleading closed=0 metric for an otherwise completed run.
    for(let i=0;i<50&&activeSockets.size>0;i++)await sleep(10);
    if(pendingResult)pendingResult.sockets.closed=closed;
    db.close();
    rmSync(folder,{recursive:true,force:true});
    if(pendingResult&&activeSockets.size!==0){
      throw new Error('S5 fixture sockets did not close within the bounded deadline');
    }
  }
}
function cli(args:string[]):S5LoadOptions{
  const p:Record<string,string>={};
  for(const arg of args){
    const m=/^--(clients|callsPerClient|mode|maxInFlight|queueCap|minuteLimit|dailyLimit)=([A-Za-z0-9]+)$/.exec(arg);
    if(!m||p[m[1]!]!==undefined)throw new Error('Invalid/duplicate option: '+arg);
    p[m[1]!]=m[2]!;
  }
  return {clients:Number(p.clients??16),callsPerClient:Number(p.callsPerClient??2),
    mode:(p.mode??'isolated') as S5LoadOptions['mode'],
    maxInFlight:Number(p.maxInFlight??8),queueCap:Number(p.queueCap??256),
    minuteLimit:Number(p.minuteLimit??600),dailyLimit:Number(p.dailyLimit??850000)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runS5LoopbackLoad(cli(process.argv.slice(2)))
    .then(x=>process.stdout.write(JSON.stringify(x,null,2)+'\n'))
    .catch(e=>{process.stderr.write(String(e)+'\n');process.exitCode=1});
}
