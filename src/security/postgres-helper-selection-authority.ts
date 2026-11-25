import {createHash,randomUUID} from 'node:crypto';
import * as z from 'zod';
import type {DispatchStorePool,DispatchStoreConnection} from '../agent/postgres-broker-dispatch-authority.js';
import type {IndependentProvenanceCheck} from '../agent/postgres-monotonic-witness.js';
import type {HelperRequest,HelperSelection,HelperCommit,TransferHelperDeploymentAuthority} from '../installer/protected-transfer-helper-lifecycle.js';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const hex=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const pin=z.strictObject({sha256:hex,signerSha256:hex});
const selection=z.strictObject({revision:uuid,pin:pin.nullable()});
const request=z.strictObject({requestId:uuid,operation:z.enum(['clean-install','upgrade','uninstall','rollback']),
  expected:selection,desired:pin.nullable(),sourcePath:z.string().min(1).max(4096).optional()});
const scope=z.strictObject({authorityId:uuid,deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),generation:z.number().int().positive().safe(),brokerId:uuid});
export type HelperAuthorityScope=Readonly<z.infer<typeof scope>>;
export type HelperLease=Readonly<{id:string;requestId:string;kind:'RUNTIME'|'DEPLOYMENT';expectedRevision:string}>;
type Phase='BEGIN_RUNTIME'|'BEGIN_DEPLOYMENT'|'READ'|'COMMIT'|'RELEASE';
export type HelperAuthorityEvidenceRequest=Readonly<{phase:Phase;scope:HelperAuthorityScope;lease:HelperLease;
  selection:HelperSelection;request?:Readonly<HelperRequest>}>;
export interface HelperSelectionAuthorityConfig {
  pool:DispatchStorePool;
  scope:HelperAuthorityScope;
  verifyProvenance:IndependentProvenanceCheck;
  /** Independently authenticated device/owner observer. BEGIN_DEPLOYMENT must
   * verify exact owner intent and drained previous runtime. COMMIT verifies
   * exact installed signed desired artifact (or detach), owner intent and
   * STOP/revoke. RELEASE verifies permanent drain of the exact lease, not a
   * timeout, socket disconnect, callback return or local PID check. READ and
   * BEGIN_RUNTIME validate the protected caller and current grant. */
  verifyEvidence:(request:HelperAuthorityEvidenceRequest)=>Promise<boolean>;
}
const deny=(code:string):never=>{throw Error(code);};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same=(a:HelperSelection,b:HelperSelection)=>a.revision===b.revision&&a.pin?.sha256===b.pin?.sha256&&a.pin?.signerSha256===b.pin?.signerSha256;
function parsedRequest(input:HelperRequest):Readonly<HelperRequest>{
  const r=request.parse(input);
  const equal=r.expected.pin?.sha256===r.desired?.sha256&&r.expected.pin?.signerSha256===r.desired?.signerSha256;
  if(!(r.operation==='clean-install'?!r.expected.pin&&!!r.desired&&!!r.sourcePath:
      r.operation==='upgrade'?!!r.expected.pin&&!!r.desired&&!equal&&!!r.sourcePath:
      r.operation==='rollback'?!!r.expected.pin&&!!r.desired&&!equal&&r.sourcePath===undefined:
      !!r.expected.pin&&r.desired===null&&r.sourcePath===undefined))return deny('HELPER_DEPLOYMENT_REQUEST_INVALID');
  if(r.expected.pin)Object.freeze(r.expected.pin);if(r.desired)Object.freeze(r.desired);
  Object.freeze(r.expected);return Object.freeze(r);
}
function parseSelection(row:Record<string,unknown>|undefined):HelperSelection{
  if(!row)return deny('HELPER_SELECTION_MISSING');
  const v=selection.parse({revision:row.revision,pin:row.sha256===null&&row.signer_sha256===null?null:{sha256:row.sha256,signerSha256:row.signer_sha256}});
  if(v.pin)Object.freeze(v.pin);return Object.freeze(v);
}
const integer=(v:unknown)=>{const n=typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):v;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1)return deny('HELPER_AUTHORITY_STATE_INVALID');return n;};

/** Independent service-side ledger. Never instantiate with Agent-local DB
 * credentials or expose methods to untrusted HTTP/MCP callers. An authenticated
 * transport must bind scope and independently verify evidence for each phase.
 * No DB transaction is held over the lifetime of a native process. Instead
 * the durable unreleased lease row excludes every other acquisition. */
export class PostgresHelperSelectionAuthority {
  private readonly c:Readonly<HelperSelectionAuthorityConfig>;
  constructor(config:HelperSelectionAuthorityConfig){
    if(typeof config?.pool?.connect!=='function'||typeof config.verifyProvenance!=='function'||typeof config.verifyEvidence!=='function')
      deny('HELPER_AUTHORITY_CONFIGURATION_REQUIRED');
    this.c=Object.freeze({...config,scope:Object.freeze(scope.parse(config.scope))});
  }
  private async trusted(){
    const p=await this.c.verifyProvenance();
    if(p?.verified!==true||p.authorityId!==this.c.scope.authorityId||!Number.isSafeInteger(p.validUntil)||p.validUntil<=Date.now())
      deny('HELPER_AUTHORITY_PROVENANCE_UNVERIFIED');
  }
  private async tx<T>(work:(db:DispatchStoreConnection,current:HelperSelection)=>Promise<T>):Promise<T>{
    await this.trusted();
    const db=await this.c.pool.connect();let active=false,committing=false,destroy=false;
    const s=this.c.scope;
    try{
      await db.query('BEGIN');active=true;
      await db.query("SET LOCAL synchronous_commit='on'");
      await db.query("SET LOCAL statement_timeout='5000ms'");
      await db.query("SET LOCAL lock_timeout='3000ms'");
      const role=(await db.query("SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS fpw,pg_is_in_recovery() AS recovery,"+
        "(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,"+
        "has_schema_privilege(current_user,'helper_selection','CREATE') AS ddl,"+
        "has_table_privilege(current_user,'core_dispatch.grants','INSERT,UPDATE,DELETE,TRUNCATE') AS grant_write,"+
        "(has_table_privilege(current_user,'helper_selection.selections','INSERT,DELETE,TRUNCATE') OR has_table_privilege(current_user,'helper_selection.leases','DELETE,TRUNCATE')) AS erase,"+
        "EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='helper_selection' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns")).rows[0];
      if(!role||role.fsync!=='on'||role.fpw!=='on'||role.recovery!==false||role.elevated!==false||role.ddl!==false||role.grant_write!==false||role.erase!==false||role.owns!==false)
        deny('HELPER_AUTHORITY_ROLE_OR_DURABILITY_INVALID');
      // Same lock and order as CORE revoke and transfer dispatch authority.
      const a=(await db.query('SELECT max_seen_ms FROM core_dispatch.authorities WHERE authority_id=$1 FOR UPDATE',[s.authorityId])).rows[0];
      if(!a)return deny('HELPER_AUTHORITY_MISSING');
      const last=integer(a.max_seen_ms);
      const clock=async()=>integer((await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS ms')).rows[0]?.ms);
      const before=await clock();if(before<last)return deny('HELPER_AUTHORITY_CLOCK_REWIND');
      const values=[s.authorityId,s.deviceId];
      const grant=(await db.query('SELECT * FROM core_dispatch.grants WHERE authority_id=$1 AND device_id=$2',values)).rows[0];
      const exact=(v:Record<string,unknown>|undefined)=>!!v&&v.owner_id===s.ownerId&&v.device_epoch===s.deviceEpoch&&v.session_epoch===s.sessionEpoch&&
        integer(v.owner_epoch)===s.ownerEpoch&&integer(v.generation)===s.generation&&v.broker_id===s.brokerId;
      if(grant?.state!=='ACTIVE'||!exact(grant))return deny('HELPER_AUTHORITY_GRANT_FENCED');
      const row=(await db.query('SELECT * FROM helper_selection.selections WHERE authority_id=$1 AND device_id=$2 FOR UPDATE',values)).rows[0];
      if(!exact(row))return deny('HELPER_SELECTION_SCOPE_FENCED');
      const result=await work(db,parseSelection(row));
      await this.trusted();const after=await clock();if(after<before)return deny('HELPER_AUTHORITY_CLOCK_REWIND');
      await db.query('UPDATE core_dispatch.authorities SET max_seen_ms=$2 WHERE authority_id=$1',[s.authorityId,after]);
      committing=true;await db.query('COMMIT');active=false;committing=false;return result;
    }catch(error){
      if(committing){destroy=true;return deny('HELPER_AUTHORITY_TRANSACTION_UNKNOWN');}
      if(active)try{await db.query('ROLLBACK');}catch{destroy=true;}
      throw error;
    }finally{db.release(destroy);}
  }
  private async evidence(phase:Phase,lease:HelperLease,current:HelperSelection,request?:Readonly<HelperRequest>){
    const value=Object.freeze({phase,scope:this.c.scope,lease,selection:current,...(request?{request}:{})});
    // A bounded external observation is mandatory. A late completion after
    // timeout cannot change this transaction or create a lease.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const accepted=await Promise.race([this.c.verifyEvidence(value),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),4000);})]);
      if(accepted!==true)deny('HELPER_AUTHORITY_EVIDENCE_DENIED');
    }finally{if(timer)clearTimeout(timer);}
  }
  private async begin(kind:HelperLease['kind'],requestId:string,req?:Readonly<HelperRequest>):Promise<HelperLease>{
    const id=uuid.parse(requestId);
    return this.tx(async(db,current)=>{
      if(kind==='RUNTIME'&&!current.pin)return deny('HELPER_NOT_SELECTED');
      if(req&&!same(req.expected,current))return deny('HELPER_SELECTION_STALE');
      if((await db.query('SELECT id FROM helper_selection.leases WHERE request_id=$1',[id])).rows.length)return deny('HELPER_REQUEST_REPLAY');
      if((await db.query("SELECT id FROM helper_selection.leases WHERE authority_id=$1 AND device_id=$2 AND state<>'RELEASED'",[this.c.scope.authorityId,this.c.scope.deviceId])).rows.length)
        return deny('HELPER_LEASE_OCCUPIED');
      const lease:HelperLease=Object.freeze({id:randomUUID(),requestId:id,kind,expectedRevision:current.revision});
      await this.evidence(kind==='RUNTIME'?'BEGIN_RUNTIME':'BEGIN_DEPLOYMENT',lease,current,req);
      const inserted=(await db.query("INSERT INTO helper_selection.leases(id,request_id,authority_id,device_id,kind,request_hash,expected_revision,state) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE') ON CONFLICT DO NOTHING RETURNING id",
        [lease.id,id,this.c.scope.authorityId,this.c.scope.deviceId,kind,digest(req??{requestId:id,kind}),current.revision])).rows[0];
      if(inserted?.id!==lease.id)return deny('HELPER_LEASE_OCCUPIED_OR_REPLAY');
      return lease;
    });
  }
  beginRuntime(requestId:string){return this.begin('RUNTIME',requestId);}
  beginDeployment(input:HelperRequest){const req=parsedRequest(input);return this.begin('DEPLOYMENT',req.requestId,req);}
  private async held(db:DispatchStoreConnection,id:string,current:HelperSelection,kind?:HelperLease['kind']){
    const row=(await db.query("SELECT * FROM helper_selection.leases WHERE id=$1 AND authority_id=$2 AND device_id=$3 FOR UPDATE",
      [uuid.parse(id),this.c.scope.authorityId,this.c.scope.deviceId])).rows[0];
    if(!row||!['ACTIVE','COMMITTED'].includes(String(row.state))||!['RUNTIME','DEPLOYMENT'].includes(String(row.kind))||
       current.revision!==(row.committed_revision??row.expected_revision))return deny('HELPER_LEASE_FENCED');
    if(kind!==undefined&&row.kind!==kind)return deny('HELPER_LEASE_ROLE_FENCED');
    const lease:HelperLease=Object.freeze({id:uuid.parse(row.id),requestId:uuid.parse(row.request_id),kind:row.kind as HelperLease['kind'],expectedRevision:uuid.parse(row.expected_revision)});
    return {row,lease};
  }
  read(leaseId:string,kind?:HelperLease['kind']):Promise<HelperSelection>{
    return this.tx(async(db,current)=>{const {lease}=await this.held(db,leaseId,current,kind);await this.evidence('READ',lease,current);return current;});
  }
  commit(leaseId:string,input:HelperRequest):Promise<HelperCommit>{
    const req=parsedRequest(input);
    return this.tx(async(db,current)=>{
      const {row,lease}=await this.held(db,leaseId,current);
      if(lease.kind!=='DEPLOYMENT'||row.state!=='ACTIVE'||lease.requestId!==req.requestId||row.request_hash!==digest(req)||!same(req.expected,current))
        return deny('HELPER_DEPLOYMENT_COMMIT_FENCED');
      await this.evidence('COMMIT',lease,current,req);
      const revision=randomUUID(),s=this.c.scope;
      const selected=(await db.query('UPDATE helper_selection.selections SET revision=$3,sha256=$4,signer_sha256=$5 WHERE authority_id=$1 AND device_id=$2 AND revision=$6 RETURNING revision',
        [s.authorityId,s.deviceId,revision,req.desired?.sha256??null,req.desired?.signerSha256??null,current.revision])).rows[0];
      if(selected?.revision!==revision)return deny('HELPER_SELECTION_CAS_FAILED');
      const committed=(await db.query("UPDATE helper_selection.leases SET state='COMMITTED',committed_revision=$2 WHERE id=$1 AND state='ACTIVE' RETURNING id",[lease.id,revision])).rows[0];
      if(committed?.id!==lease.id)return deny('HELPER_LEASE_CAS_FAILED');
      return 'COMMITTED' as const;
    });
  }
  /** Explicit, independently verified permanent drain. No TTL/reconnect
   * release, no retry on UNKNOWN, and no clearance after revoke by this role.
   * A revoked scope or unavailable DB requires operator reconciliation. */
  release(leaseId:string,kind?:HelperLease['kind']):Promise<void>{
    return this.tx(async(db,current)=>{
      const {lease}=await this.held(db,leaseId,current,kind);
      await this.evidence('RELEASE',lease,current);
      const row=(await db.query("UPDATE helper_selection.leases SET state='RELEASED' WHERE id=$1 AND state IN ('ACTIVE','COMMITTED') RETURNING id",[lease.id])).rows[0];
      if(row?.id!==lease.id)return deny('HELPER_LEASE_RELEASE_FENCED');
    });
  }
}
/** Transport must authenticate the protected device on every operation and
 * reach the independent ledger, not construct a local database or authority.
 * No ambient env/CLI credentials. Structural interface for AI-07 integration. */
export interface HelperSelectionLeaseTransport {
  beginRuntime(requestId:string):Promise<HelperLease>;
  beginDeployment(request:Readonly<HelperRequest>):Promise<HelperLease>;
  read(leaseId:string):Promise<HelperSelection>;
  commit(leaseId:string,request:Readonly<HelperRequest>):Promise<HelperCommit>;
  release(leaseId:string):Promise<void>;
}
export function createHelperSelectionLeaseProvider(transport:HelperSelectionLeaseTransport):TransferHelperDeploymentAuthority&{
  withActiveSelection<T>(effect:()=>Promise<T>):Promise<T>;
}{
  let busy=false,poisoned=false,runtimeUsed=false,held:HelperLease|undefined;
  const validateLease=(lease:HelperLease,kind:HelperLease['kind'],requestId:string)=>{
    if(!lease||lease.kind!==kind||uuid.parse(lease.requestId)!==requestId||!uuid.safeParse(lease.id).success||!uuid.safeParse(lease.expectedRevision).success)
      return deny('HELPER_LEASE_RECEIPT_INVALID');
    return Object.freeze({id:lease.id,requestId,kind,expectedRevision:lease.expectedRevision});
  };
  async function use<T>(kind:HelperLease['kind'],effect:()=>Promise<T>,req?:Readonly<HelperRequest>){
    if(busy)return deny('HELPER_LOCAL_SCOPE_BUSY');
    if(poisoned||runtimeUsed)return deny('HELPER_LOCAL_SCOPE_RETIRED');
    if(kind==='RUNTIME')runtimeUsed=true;
    busy=true;
    try{
      const id=req?.requestId??randomUUID();
      held=validateLease(await (req?transport.beginDeployment(req):transport.beginRuntime(id)),kind,id);
      if(req&&held.expectedRevision!==req.expected.revision)return deny('HELPER_LEASE_RECEIPT_INVALID');
      const result=await effect();
      // Failure/UNKNOWN leaves durable lease occupied. Even success cannot
      // release until the service independently verifies permanent drain.
      await transport.release(held.id);
      return result;
    }catch(error){poisoned=true;throw error;}
    finally{held=undefined;busy=false;}
  }
  return Object.freeze({
    withActiveSelection<T>(effect:()=>Promise<T>){return use('RUNTIME',effect);},
    withExclusiveQuiescedDeployment<T>(req:Readonly<HelperRequest>,effect:()=>Promise<T>){return use('DEPLOYMENT',effect,parsedRequest(req));},
    async readSelection(){
      const lease=held;if(!lease)return deny('HELPER_LEASE_REQUIRED');
      const value=await transport.read(lease.id);
      if(held!==lease)return deny('HELPER_LEASE_FENCED');return value;
    },
    async commitSelection(req:Readonly<HelperRequest>){
      if(!held||held.kind!=='DEPLOYMENT'||held.requestId!==req.requestId)return deny('HELPER_DEPLOYMENT_LEASE_REQUIRED');
      const lease=held;
      const value=await transport.commit(lease.id,parsedRequest(req));
      if(held!==lease)return deny('HELPER_AUTHORITY_TRANSACTION_UNKNOWN');return value;
    },
  });
}
