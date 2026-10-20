import {timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import {verifyAgentJournalWal} from './operation-journal-wal.js';

const uuid=z.string().uuid();
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const input=z.object({
  deviceId:uuid,epoch:uuid,requestId:uuid,
  fingerprint:hash,capability:z.string().min(1).max(128),
}).strict();
const answer=z.object({
  authorityId:uuid,deviceId:uuid,epoch:uuid,requestId:uuid,
  created:z.boolean(),sequence:z.number().int().positive().safe(),
}).strict();
export type CasReservation=z.infer<typeof answer>;
export type CasRequest=z.infer<typeof input>;
/**
 * Authoritative monotonic CAS, hosted in a DIFFERENT backup/security domain
 * from BOTH the Agent and this reference CAS gateway's SQLite cache.
 * This interface must be backed by verified conditional-create durable
 * storage. In-memory and local SQLite implementations are TEST ONLY.
 */
export interface MonotonicTrustRoot {
  reserve(request:CasRequest):Promise<CasReservation>;
}
export class MutationCasError extends Error{
  constructor(readonly code:string,message:string){
    super(message);this.name='MutationCasError';
  }
}
const fail=(code:string):never=>{
  throw new MutationCasError(code,'Independent mutation reservation cannot be verified.');
};
/** Production accepts only a trusted HTTPS authority hosted outside rollback domain. */
export class RemoteMutationCasClient{
  private readonly url:URL;
  constructor(readonly settings:{
    endpoint:string;token:string;deviceId:string;epoch:string;
    authorityId:string;timeoutMs?:number
  }){
    this.url=new URL(settings.endpoint);
    if(this.url.protocol!=='https:'||this.url.username||this.url.password||
       this.url.search||this.url.hash||this.url.pathname!=='/v1/reservations'||
       !settings.token||settings.token.length<16||
       !uuid.safeParse(settings.deviceId).success||
       !uuid.safeParse(settings.epoch).success||
       !uuid.safeParse(settings.authorityId).success)fail('CAS_CONFIG_INVALID');
  }
  async reserve(requestId:string,fingerprint:string,capability:string):
    Promise<CasReservation>{
    const body=input.parse({
      deviceId:this.settings.deviceId,epoch:this.settings.epoch,
      requestId,fingerprint,capability,
    });
    let response:Response;
    try{
      response=await fetch(this.url,{
        method:'POST',redirect:'error',cache:'no-store',
        headers:{'content-type':'application/json',
          authorization:'Bearer '+this.settings.token},
        body:JSON.stringify(body),
        signal:AbortSignal.timeout(this.settings.timeoutMs??3500),
      });
    }catch{return fail('CAS_UNAVAILABLE')}
    if(!response.ok)fail('CAS_NOT_AUTHORIZED_OR_UNAVAILABLE');
    let content:string;
    try{content=await response.text()}catch{return fail('CAS_INVALID_PROOF')}
    if(content.length>2000)fail('CAS_INVALID_PROOF');
    let decoded:unknown;
    try{decoded=JSON.parse(content)}catch{return fail('CAS_INVALID_PROOF')}
    const parsed=answer.safeParse(decoded);
    if(!parsed.success)return fail('CAS_INVALID_PROOF');
    const r=parsed.data;
    if(r.authorityId!==this.settings.authorityId||
       r.deviceId!==body.deviceId||r.epoch!==body.epoch||
       r.requestId!==body.requestId)fail('CAS_SCOPE_MISMATCH');
    return r;
  }
}
/**
 * HTTPS client for an independently operated MONOTONIC witness service.
 * Credential resolver must come from an owner-authorized enrollment store,
 * never from unauthenticated request input.
 *
 * The witness endpoint itself must enforce atomic durable create-if-absent.
 * Transport security alone does NOT prove non-rollback storage provenance.
 */
export class HttpsMonotonicTrustRoot implements MonotonicTrustRoot {
  constructor(private readonly config:{
    endpoint:string;authorityId:string;
    tokenForEnrolledDevice:(deviceId:string,epoch:string)=>string|undefined;
    timeoutMs?:number;
  }){}
  async reserve(request:CasRequest):Promise<CasReservation>{
    const inputRecord=input.parse(request);
    const credential=this.config.tokenForEnrolledDevice(
      inputRecord.deviceId,inputRecord.epoch);
    if(!credential)fail('CAS_WITNESS_ENROLLMENT_MISSING');
    return new RemoteMutationCasClient({
      endpoint:this.config.endpoint,token:credential!,
      authorityId:this.config.authorityId,
      deviceId:inputRecord.deviceId,epoch:inputRecord.epoch,
      timeoutMs:this.config.timeoutMs,
    }).reserve(inputRecord.requestId,inputRecord.fingerprint,
      inputRecord.capability);
  }
}
function equal(a:string,b:string):boolean{
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length&&timingSafeEqual(x,y);
}
export type IndependentCasCredential={
  token:string;deviceId:string;epoch:string;
};
/**
 * Reference durable server: run on ANOTHER host/volume/account not restorable
 * together with Agent journal, with independently audited TLS and backups.
 * For CI the server is an isolated HTTPS loopback process with its OWN DB.
 * It does not claim protection against rollback of the remote database itself.
 */
/** Explicit, separately authorized provisioning. Never silently bootstrap after
 * lost remote storage: loss of tombstones must stop the CAS service. */
export async function provisionIndependentCasDatabase(
  dbFile:string,authorityId:string,
):Promise<void>{
  if(!path.isAbsolute(dbFile)||!uuid.safeParse(authorityId).success)
    fail('CAS_SERVER_CONFIG_INVALID');
  await fs.mkdir(path.dirname(dbFile),{recursive:true});
  const f=await fs.open(dbFile,'wx',0o600);
  await f.close();
  const db=new DatabaseSync(dbFile);
  try{
    db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL');
    db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1),authority_id TEXT NOT NULL)');
    db.exec('CREATE TABLE reservations ('+
      'sequence INTEGER PRIMARY KEY AUTOINCREMENT,device_id TEXT NOT NULL,'+
      'epoch TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,'+
      'capability TEXT NOT NULL, UNIQUE(device_id,request_id))');
    db.prepare('INSERT INTO meta VALUES(1,?)').run(authorityId);
  }finally{db.close()}
}
export async function createIndependentCasHandler(options:{
  dbFile:string;authorityId:string;
  credentials:()=>readonly IndependentCasCredential[];
  trustRoot:MonotonicTrustRoot;
  maxPageGrowthForTest?:number;
}):Promise<{
  handler:(req:IncomingMessage,res:ServerResponse)=>void;
  close:()=>void;
}>{
  if(!path.isAbsolute(options.dbFile)||!uuid.safeParse(options.authorityId).success)
    fail('CAS_SERVER_CONFIG_INVALID');
  if(!options.trustRoot||typeof options.trustRoot.reserve!=='function')
    fail('CAS_TRUST_ROOT_REQUIRED');
  const stat=await fs.lstat(options.dbFile).catch(()=>fail('CAS_SERVER_UNAVAILABLE'));
  if(!stat.isFile()||stat.isSymbolicLink())fail('CAS_SERVER_UNAVAILABLE');
  // A corrupt hot WAL can make SQLite silently discard recent cache rows.
  // Even though the witness is authoritative, require explicit recovery.
  await verifyAgentJournalWal(options.dbFile);
  const db=new DatabaseSync(options.dbFile);
  try{
    db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000');
    const existing=db.prepare('SELECT authority_id FROM meta WHERE id=1')
      .get() as {authority_id:string}|undefined;
    if(!existing||existing.authority_id!==options.authorityId)
      fail('CAS_SERVER_EPOCH_MISMATCH');
    const quick=db.prepare('PRAGMA quick_check').get() as {quick_check:string};
    if(quick.quick_check!=='ok')fail('CAS_SERVER_CORRUPT');
    if(options.maxPageGrowthForTest!==undefined){
      const count=db.prepare('PRAGMA page_count').get() as {page_count:number};
      db.exec('PRAGMA max_page_count='+(count.page_count+options.maxPageGrowthForTest));
    }
  }catch(e){db.close();throw e}
  const respond=(res:ServerResponse,status:number,payload:unknown)=>{
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(payload));
  };
  return {close:()=>db.close(),handler:(req,res)=>{
    void (async()=>{
      if(req.method!=='POST'||req.url!=='/v1/reservations'){
        respond(res,404,{error:'not_found'});return;
      }
      const header=req.headers.authorization??'';
      if(!header.startsWith('Bearer ')){
        respond(res,403,{error:'not_authorized'});return;
      }
      const token=header.slice(7);
      const permitted=options.credentials().find(item=>equal(token,item.token));
      if(!permitted){
        respond(res,403,{error:'not_authorized'});return;
      }
      let raw='';
      for await(const part of req){
        raw+=String(part);
        if(raw.length>2048){respond(res,413,{error:'too_large'});return}
      }
      const checked=input.safeParse(JSON.parse(raw));
      if(!checked.success||checked.data.deviceId!==permitted.deviceId||
         checked.data.epoch!==permitted.epoch){
        respond(res,403,{error:'invalid_scope'});return;
      }
      const body=checked.data;
      // The rollback-independent witness MUST commit first. An uncertain
      // response or missing witness denies execution, never falls back to a
      // locally restored SQLite row or a newly minted epoch.
      let proof:CasReservation;
      try {
        const raw=await options.trustRoot.reserve(body);
        proof=answer.parse(raw);
        if(proof.authorityId!==options.authorityId||
           proof.deviceId!==body.deviceId||proof.epoch!==body.epoch||
           proof.requestId!==body.requestId)throw new Error('Witness scope mismatch');
      }catch{
        respond(res,503,{error:'trust_root_unavailable'});return;
      }
      db.exec('BEGIN IMMEDIATE');
      try{
        const old=db.prepare('SELECT sequence,epoch,fingerprint,capability FROM reservations '+
          'WHERE device_id=? AND request_id=?').get(body.deviceId,body.requestId) as
          {sequence:number;epoch:string;fingerprint:string;capability:string}|undefined;
        if(old&&(old.epoch!==body.epoch||
            old.fingerprint!==body.fingerprint||old.capability!==body.capability)){
          db.exec('ROLLBACK');respond(res,409,{error:'historical_conflict'});return;
        }
        if(old&&proof.created){
          // Witness says new but local cache already has the ID: witness
          // rollback, fork or inconsistent provenance. Hard fail closed.
          db.exec('ROLLBACK');respond(res,503,{error:'trust_root_divergence'});return;
        }
        if(!old&&proof.created){
          const result=db.prepare('INSERT INTO reservations '+
            '(device_id,epoch,request_id,fingerprint,capability) VALUES(?,?,?,?,?)')
            .run(body.deviceId,body.epoch,body.requestId,body.fingerprint,body.capability);
          // Local row is an OPTIONAL cache, not a source of CAS truth.
          if(Number(result.lastInsertRowid)<1)
            throw new Error('Local cache write not confirmed');
        }
        db.exec('COMMIT');
        respond(res,200,proof);
      }catch(e){
        try{db.exec('ROLLBACK')}catch{}
        respond(res,503,{error:'reservation_unavailable'});
      }
    })().catch(()=>{if(!res.headersSent)respond(res,503,{error:'unavailable'})});
  }};
}
