/**
 * CLEAN-10 fail-closed semantic-effect reservation.
 *
 * A file created with O_EXCL is a tombstone, not a lease: a process crash,
 * dropped ACK, or successful local callback never makes the same effect safe
 * to dispatch again. Only a separately authenticated *new user intent* can
 * acquire another reservation. No TTL or deletion path is exposed.
 */
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const Digest=z.string().regex(/^[a-f0-9]{64}$/);
const Scope=z.string().min(1).max(256);
const IntentId=z.string().uuid();
const Stamp=z.object({
  version:z.literal(1),
  fingerprint:Digest,
  ownerId:Scope,
  deviceId:Scope,
  runbookId:Scope,
  stepId:Scope,
  graphId:Scope,
  intentDigest:Digest.optional(),
  reservedAt:z.string().datetime(),
}).strict();
const OwnerStamp=z.object({
  version:z.literal(1),
  ownerId:Scope,
  deviceId:Scope,
}).strict();

export interface AuthorizedNewEffectIntent {
  id:string;
  ownerId:string;
  deviceId:string;
  authorizationReceipt:string;
}
export interface SemanticEffectReservation {
  fingerprint:string;
  runbookId:string;
  stepId:string;
  graphId:string;
  newIntent?:AuthorizedNewEffectIntent;
}
export type VerifyNewEffectIntent = (input: {
  intent:AuthorizedNewEffectIntent;
  fingerprint:string;
  ownerId:string;
  deviceId:string;
})=>Promise<boolean>;

export class SemanticEffectJournalError extends Error {
  constructor(public readonly code:string,message:string){
    super(message);
    this.name='SemanticEffectJournalError';
  }
}
function deny(code:string):never {
  throw new SemanticEffectJournalError(code,'Semantic effect requires independent owner/device-bound reconciliation or fresh intent authorization.');
}

/** Canonical key order is important: neither runbook_id nor step ID
 * authorizes a fresh effect, and JSON key ordering must not bypass a tombstone.
 * This is an EXACT semantic-graph fingerprint, not a general proof of
 * equivalence for arbitrary changed commands. */
function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value!==null&&typeof value==='object')
    return Object.fromEntries(Object.entries(value as Record<string,unknown>)
      .sort(([a],[b])=>a<b?-1:a>b?1:0)
      .map(([key,v])=>[key,canonical(v)]));
  return value;
}
export function semanticEffectFingerprint(taskGraph:Record<string,unknown>,uiTarget:string):string {
  // A requested graph_id and retry toggles are transport-admission aliases,
  // not owner proof. Remove them before fingerprinting the task graph.
  const {graph_id:ignoredId,resume:ignoredResume,retry_failed:ignoredFailed,
    retry_unknown:ignoredUnknown,total_timeout_ms:ignoredTimeout,...effect}=taskGraph;
  void ignoredId;void ignoredResume;void ignoredFailed;void ignoredUnknown;void ignoredTimeout;
  return createHash('sha256').update(JSON.stringify(canonical({
    version:1,uiTarget,task_graph:effect,
  }))).digest('hex');
}
export function semanticEffectGraphId(fingerprint:string,intentId?:string):string {
  return 'rb-'+createHash('sha256')
    .update('clean10-graph-v1\0'+fingerprint+'\0'+(intentId??''))
    .digest('hex').slice(0,32);
}
function hasCode(error:unknown,code:string):boolean{
  return typeof error==='object'&&error!==null&&'code' in error&&error.code===code;
}
export class SemanticEffectJournal {
  private readonly root:string;
  private readonly ownerId:string;
  private readonly deviceId:string;
  constructor(input:{stateFile:string;ownerId:string;deviceId:string}){
    this.root=input.stateFile+'.semantic-effects';
    this.ownerId=Scope.parse(input.ownerId);
    this.deviceId=Scope.parse(input.deviceId);
  }
  private async createExclusive(name:string,value:object):Promise<boolean>{
    const file=path.join(this.root,name);
    let handle:Awaited<ReturnType<typeof fs.open>>;
    try{handle=await fs.open(file,'wx',0o600);}
    catch(error){
      if(hasCode(error,'EEXIST'))return false;
      deny('RUNBOOK_EFFECT_JOURNAL_UNAVAILABLE');
    }
    try{
      await handle.writeFile(JSON.stringify(value)+'\n','utf8');
      await handle.sync();
    }catch{
      // Never remove the possibly-created reservation: it may be the only
      // evidence that a preceding dispatch was admitted.
      deny('RUNBOOK_EFFECT_JOURNAL_UNAVAILABLE');
    }finally{
      await handle.close().catch(()=>undefined);
    }
    // Persist directory entry on POSIX. Windows directory fsync is not
    // uniformly supported; the file is still synced before any dispatch.
    if(process.platform!=='win32'){
      let directory:Awaited<ReturnType<typeof fs.open>>|undefined;
      try{
        directory=await fs.open(this.root,'r');
        await directory.sync();
      }catch{deny('RUNBOOK_EFFECT_JOURNAL_UNAVAILABLE');}
      finally{await directory?.close().catch(()=>undefined);}
    }
    return true;
  }
  private async safeRead(name:string):Promise<string>{
    const file=path.join(this.root,name);
    let stat:Awaited<ReturnType<typeof fs.lstat>>;
    try{stat=await fs.lstat(file);}
    catch{deny('RUNBOOK_EFFECT_JOURNAL_UNAVAILABLE');}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
      stat.size<=0||stat.size>4096||
      (process.platform!=='win32'&&((stat.mode&0o077)!==0||
        (typeof process.getuid==='function'&&stat.uid!==process.getuid()))))
      deny('RUNBOOK_EFFECT_JOURNAL_CORRUPT');
    try{return await fs.readFile(file,'utf8');}
    catch{deny('RUNBOOK_EFFECT_JOURNAL_UNAVAILABLE');}
  }
  private async readExisting(name:string):Promise<z.infer<typeof Stamp>>{
    const raw=await this.safeRead(name);
    const parsed=Stamp.safeParse((()=>{try{return JSON.parse(raw)}catch{return null}})());
    if(!parsed.success)deny('RUNBOOK_EFFECT_JOURNAL_CORRUPT');
    const record=parsed.data;
    if(record.ownerId!==this.ownerId||record.deviceId!==this.deviceId)
      deny('RUNBOOK_EFFECT_OWNER_DEVICE_MISMATCH');
    return record;
  }
  private async ensureRoot():Promise<void>{
    try{
      await fs.mkdir(this.root,{recursive:true,mode:0o700});
      const stat=await fs.lstat(this.root);
      if(!stat.isDirectory()||stat.isSymbolicLink()||
        (process.platform!=='win32'&&((stat.mode&0o077)!==0||
          (typeof process.getuid==='function'&&stat.uid!==process.getuid()))))
        deny('RUNBOOK_EFFECT_JOURNAL_UNSAFE_ROOT');
      const identity=OwnerStamp.parse({version:1,ownerId:this.ownerId,deviceId:this.deviceId});
      const created=await this.createExclusive('owner.json',identity);
      if(!created){
        let existing:unknown;
        try{existing=JSON.parse(await this.safeRead('owner.json'));}
        catch{deny('RUNBOOK_EFFECT_JOURNAL_CORRUPT');}
        const loaded=OwnerStamp.safeParse(existing);
        if(!loaded.success)deny('RUNBOOK_EFFECT_JOURNAL_CORRUPT');
        if(loaded.data.ownerId!==this.ownerId||loaded.data.deviceId!==this.deviceId)
          deny('RUNBOOK_EFFECT_OWNER_DEVICE_MISMATCH');
      }
    }catch(error){
      if(error instanceof SemanticEffectJournalError)throw error;
      deny('RUNBOOK_EFFECT_JOURNAL_UNAVAILABLE');
    }
  }
  async reserve(input:SemanticEffectReservation,verifyNewIntent?:VerifyNewEffectIntent):Promise<void>{
    const fingerprint=Digest.parse(input.fingerprint);
    const id=Scope.parse(input.runbookId);
    const stepId=Scope.parse(input.stepId);
    const graphId=Scope.parse(input.graphId);
    await this.ensureRoot();
    const baseName='effect-'+fingerprint+'.json';
    const common={version:1 as const,fingerprint,
      ownerId:this.ownerId,deviceId:this.deviceId,
      runbookId:id,stepId,graphId,reservedAt:new Date().toISOString()};
    if(await this.createExclusive(baseName,common))return;
    const original=await this.readExisting(baseName);
    if(original.fingerprint!==fingerprint)deny('RUNBOOK_EFFECT_JOURNAL_CORRUPT');
    // Nothing about a new runbook_id, retry_unknown, or a new request UUID
    // authorizes a repeat. Such an intent requires a trusted verification
    // function supplied by the authenticated owner boundary, not user JSON.
    const intent=input.newIntent;
    if(!intent||!verifyNewIntent)deny('RUNBOOK_EFFECT_ALREADY_RESERVED');
    if(intent.ownerId!==this.ownerId||intent.deviceId!==this.deviceId)
      deny('RUNBOOK_EFFECT_OWNER_DEVICE_MISMATCH');
    const intentId=IntentId.parse(intent.id);
    if(!intent.authorizationReceipt||intent.authorizationReceipt.length>4096)
      deny('RUNBOOK_EFFECT_NEW_INTENT_INVALID');
    let permitted=false;
    try{permitted=(await verifyNewIntent({
      intent,fingerprint,ownerId:this.ownerId,deviceId:this.deviceId,
    }))===true;}catch{permitted=false;}
    if(!permitted)deny('RUNBOOK_EFFECT_FRESH_INTENT_NOT_AUTHORIZED');
    const intentDigest=createHash('sha256').update(
      this.ownerId+'\0'+this.deviceId+'\0'+intentId).digest('hex');
    const uniqueName='intent-'+intentDigest+'.json';
    if(!await this.createExclusive(uniqueName,{...common,intentDigest}))
      deny('RUNBOOK_EFFECT_ALREADY_RESERVED');
  }
}
