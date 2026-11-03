import {createPrivateKey,randomUUID,sign,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import type {BrokerDispatchRequest,DispatchClaim,DispatchReleaseRequest,
  DispatchRevokeRequest,ExternalBrokerDispatchAuthority,ProtectedBrokerEvidence}
  from './broker-external-dispatch-fence.js';
import {WitnessAuthorityError,type IndependentProvenanceCheck}
  from './postgres-monotonic-witness.js';

const uuid=z.string().uuid(),positive=z.number().int().positive().safe();
const nonceSchema=z.string().regex(/^[a-f0-9]{64}$/);
const scope=z.strictObject({ownerId:uuid,deviceId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:positive,expectedGeneration:positive,requiredPrivilege:z.enum(['CORE','ROOT'])});
const operation=z.strictObject({requestId:uuid,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  capability:z.string().min(1).max(128),scope});
const brokerSchema=z.strictObject({verified:z.literal(true),brokerId:uuid,
  ownerEpoch:positive,grantGeneration:positive,highIntegrityToken:z.literal(true),
  signedProtectedImage:z.literal(true),protectedParentAndImports:z.literal(true)});
const revokeSchema=z.strictObject({deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,
  sessionEpoch:uuid,expectedGeneration:positive,signedOwnerApproval:z.string().min(32).max(8192)});
const releaseSchema=z.strictObject({dispatchId:uuid,brokerId:uuid,request:operation});
const fail=(code:string):never=>{throw new WitnessAuthorityError(code)};
function integer(value:unknown,min=0):number{
  const n=typeof value==='string'?Number(value):value;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min)return fail('DISPATCH_STORE_CORRUPT');
  return n;
}
function frozenRequest(input:BrokerDispatchRequest):BrokerDispatchRequest{
  const parsed=operation.parse(input);Object.freeze(parsed.scope);return Object.freeze(parsed);
}
function sameRequest(raw:unknown,expected:BrokerDispatchRequest):boolean{
  const parsed=operation.safeParse(raw);
  if(!parsed.success)return false;
  const a=parsed.data,b=expected;
  return a.requestId===b.requestId&&a.capability===b.capability&&a.fingerprint===b.fingerprint&&
    (Object.keys(b.scope) as Array<keyof typeof b.scope>).every(k=>a.scope[k]===b.scope[k]);
}
export interface DispatchStoreConnection {
  query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
  /** Destroy a connection with an ambiguous COMMIT/ROLLBACK; never reuse it. */
  release(destroy?:boolean):void;
}
export interface DispatchStorePool {connect():Promise<DispatchStoreConnection>}
type Transaction={db:DispatchStoreConnection;now:()=>Promise<number>};
type Grant=Record<string,unknown>;

/**
 * Durable external dispatch server implementation, not an Agent fallback.
 * Every mutation serializes on a pre-provisioned authority row and its grant.
 * Global UUID tombstones are permanent, including lost acknowledgements.
 * PostgreSQL itself is NOT anti-restore storage. A separately protected
 * provenance/restore controller and real protected Broker observer are required
 * on every admission. Neither is synthesized by this class or its SQL schema.
 */
export class PostgresBrokerDispatchAuthority implements ExternalBrokerDispatchAuthority {
  private readonly authorityId:string;
  private readonly signingKey:KeyObject;
  private readonly permitMs:number;
  private readonly drainMs:number;
  private readonly pool:DispatchStorePool;
  private readonly provenance:IndependentProvenanceCheck;
  private readonly observe:(request:BrokerDispatchRequest)=>Promise<ProtectedBrokerEvidence|undefined>;
  private readonly verifyRevoke:(request:DispatchRevokeRequest)=>Promise<boolean>;
  private readonly verifyDrain:(request:DispatchRevokeRequest)=>Promise<boolean>;
  constructor(config:{pool:DispatchStorePool;authorityId:string;privateKeyPem:string;
    verifyProvenance:IndependentProvenanceCheck;
    readProtectedBroker:(request:BrokerDispatchRequest)=>Promise<ProtectedBrokerEvidence|undefined>;
    verifyOwnerRevocation:(request:DispatchRevokeRequest)=>Promise<boolean>;
    /** Zero pending DB claims alone is not proof that kernel processes drained. */
    verifyNativeDrain:(request:DispatchRevokeRequest)=>Promise<boolean>;
    permitMs?:number;drainTimeoutMs?:number}){
    this.authorityId=uuid.parse(config.authorityId);
    this.signingKey=createPrivateKey(config.privateKeyPem);
    if(this.signingKey.asymmetricKeyType!=='ed25519')fail('DISPATCH_STORE_SIGNER_INVALID');
    this.permitMs=config.permitMs??2000;this.drainMs=config.drainTimeoutMs??2000;
    if(!Number.isSafeInteger(this.permitMs)||this.permitMs<10||this.permitMs>5000||
      !Number.isSafeInteger(this.drainMs)||this.drainMs<0||this.drainMs>5000||
      typeof config.verifyProvenance!=='function'||typeof config.readProtectedBroker!=='function'||
      typeof config.verifyOwnerRevocation!=='function'||typeof config.pool?.connect!=='function')
      fail('DISPATCH_STORE_CONFIG_INVALID');
    this.pool=config.pool;this.provenance=config.verifyProvenance;
    this.observe=config.readProtectedBroker;this.verifyRevoke=config.verifyOwnerRevocation;
    if(typeof config.verifyNativeDrain!=='function')fail('DISPATCH_STORE_CONFIG_INVALID');
    this.verifyDrain=config.verifyNativeDrain;
  }
  private async trusted():Promise<void>{
    let p;
    try{p=await this.provenance()}catch{return fail('DISPATCH_STORE_PROVENANCE_UNAVAILABLE')}
    if(!p||p.verified!==true||p.authorityId!==this.authorityId||
      !Number.isSafeInteger(p.validUntil)||p.validUntil<=Date.now())
      fail('DISPATCH_STORE_PROVENANCE_UNVERIFIED');
  }
  private async currentBroker(op:BrokerDispatchRequest,expected:ProtectedBrokerEvidence):Promise<void>{
    let observed;
    try{observed=brokerSchema.safeParse(await this.observe(op))}
    catch{return fail('DISPATCH_STORE_BROKER_UNAVAILABLE')}
    if(!observed.success||observed.data.brokerId!==expected.brokerId||
      observed.data.ownerEpoch!==op.scope.ownerEpoch||
      observed.data.grantGeneration!==op.scope.expectedGeneration)
      fail('DISPATCH_STORE_BROKER_UNVERIFIED');
  }
  private async transaction<T>(fn:(tx:Transaction)=>Promise<T>):Promise<T>{
    let db:DispatchStoreConnection;
    try{db=await this.pool.connect()}catch{return fail('DISPATCH_STORE_UNAVAILABLE')}
    let began=false,committing=false,destroy=false;
    try{
      await db.query('BEGIN');began=true;
      await db.query("SET LOCAL synchronous_commit='on'");
      await db.query("SET LOCAL statement_timeout='5000ms'");
      await db.query("SET LOCAL lock_timeout='3000ms'");
      const settings=(await db.query("SELECT current_setting('fsync') AS fsync,"+
        "current_setting('full_page_writes') AS full_page_writes,pg_is_in_recovery() AS recovery,"+
        '(SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication '+
        'FROM pg_roles WHERE rolname=current_user) AS privileged_role,'+
        "has_schema_privilege(current_user,'core_dispatch','CREATE') AS schema_create,"+
        "has_table_privilege(current_user,'core_dispatch.claims','DELETE') AS history_delete,"+
        "has_table_privilege(current_user,'core_dispatch.claims','TRUNCATE') AS history_truncate,"+
        "has_table_privilege(current_user,'core_dispatch.grants','INSERT') AS grant_provision,"+
        "has_column_privilege(current_user,'core_dispatch.grants','owner_id','UPDATE') AS owner_rewrite")).rows[0];
      if(settings?.fsync!=='on'||settings.full_page_writes!=='on'||settings.recovery!==false)
        fail('DISPATCH_STORE_DURABILITY_UNVERIFIED');
      if(settings?.privileged_role!==false||settings.schema_create!==false||
        settings.history_delete!==false||settings.history_truncate!==false||
        settings.grant_provision!==false||settings.owner_rewrite!==false)
        fail('DISPATCH_STORE_ROLE_OVERPRIVILEGED');
      const authority=(await db.query('SELECT max_seen_ms FROM core_dispatch.authorities '+
        'WHERE authority_id=$1 FOR UPDATE',[this.authorityId])).rows[0];
      if(!authority)fail('DISPATCH_STORE_NOT_PROVISIONED');
      let last=integer(authority?.max_seen_ms,1);
      const now=async()=>{
        const row=(await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms')).rows[0];
        const time=integer(row?.now_ms,1);
        if(time<last)fail('DISPATCH_STORE_CLOCK_REWIND');
        last=time;return time;
      };
      const result=await fn({db,now});
      await db.query('UPDATE core_dispatch.authorities SET max_seen_ms=$2 WHERE authority_id=$1',
        [this.authorityId,await now()]);
      committing=true;
      await db.query('COMMIT');began=false;committing=false;
      return result;
    }catch(error){
      if(committing)destroy=true;
      if(began){try{await db.query('ROLLBACK')}catch{destroy=true}}
      if(error instanceof WitnessAuthorityError)throw error;
      return fail('DISPATCH_STORE_TRANSACTION_UNKNOWN');
    }finally{db.release(destroy)}
  }
  private async grant(tx:Transaction,op:BrokerDispatchRequest,broker:ProtectedBrokerEvidence):Promise<Grant>{
    const s=op.scope;
    const row=(await tx.db.query('SELECT * FROM core_dispatch.grants '+
      'WHERE authority_id=$1 AND device_id=$2 FOR UPDATE',[this.authorityId,s.deviceId])).rows[0];
    if(!row||row.state!=='ACTIVE'||row.owner_id!==s.ownerId||row.device_epoch!==s.deviceEpoch||
      row.session_epoch!==s.sessionEpoch||row.broker_id!==broker.brokerId||
      integer(row.owner_epoch,1)!==s.ownerEpoch||integer(row.generation,1)!==s.expectedGeneration)
      return fail('DISPATCH_STORE_GRANT_REVOKED');
    const time=await tx.now();
    if((s.requiredPrivilege==='CORE'&&row.core_enabled!==true)||
      (s.requiredPrivilege==='ROOT'&&(row.root_expires_ms===null||integer(row.root_expires_ms,1)<=time)))
      fail('DISPATCH_STORE_PRIVILEGE_EXPIRED');
    return row;
  }
  private signed(value:Record<string,unknown>):DispatchClaim{
    const bytes=Buffer.from(JSON.stringify(value),'utf8');
    return {payload:bytes.toString('base64url'),signature:sign(null,bytes,this.signingKey).toString('base64url')};
  }
  private permit(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    op:BrokerDispatchRequest,broker:ProtectedBrokerEvidence,dispatchId:string,nonce:string,
    time:number,expiresAtMs:number):DispatchClaim{
    return this.signed({kind,authorityId:this.authorityId,brokerId:broker.brokerId,dispatchId,
      challengeNonce:nonce,requestId:op.requestId,fingerprint:op.fingerprint,capability:op.capability,
      ownerId:op.scope.ownerId,deviceId:op.scope.deviceId,deviceEpoch:op.scope.deviceEpoch,
      sessionEpoch:op.scope.sessionEpoch,ownerEpoch:op.scope.ownerEpoch,
      generation:op.scope.expectedGeneration,privilege:op.scope.requiredPrivilege,
      issuedAtMs:time,expiresAtMs});
  }
  private expiry(op:BrokerDispatchRequest,grant:Grant,time:number):number{
    const expires=op.scope.requiredPrivilege==='ROOT'
      ?Math.min(time+this.permitMs,integer(grant.root_expires_ms,1)):time+this.permitMs;
    if(expires<=time)fail('DISPATCH_STORE_PRIVILEGE_EXPIRED');
    return expires;
  }
  async beginIfCurrent(value:BrokerDispatchRequest,evidence:ProtectedBrokerEvidence,nonce:string):Promise<DispatchClaim>{
    const op=frozenRequest(value),broker=Object.freeze(brokerSchema.parse(evidence));nonceSchema.parse(nonce);
    await this.trusted();await this.currentBroker(op,broker);
    return this.transaction(async tx=>{
      await this.grant(tx,op,broker);
      const previous=(await tx.db.query('SELECT request_id FROM core_dispatch.claims WHERE request_id=$1',
        [op.requestId])).rows[0];
      if(previous)fail('DISPATCH_STORE_REQUEST_REPLAY');
      await this.trusted();await this.currentBroker(op,broker);
      const grant=await this.grant(tx,op,broker);
      const time=await tx.now(),expires=this.expiry(op,grant,time),dispatchId=randomUUID();
      const sequence=(await tx.db.query('UPDATE core_dispatch.authorities SET sequence=sequence+1 '+
        'WHERE authority_id=$1 RETURNING sequence',[this.authorityId])).rows[0];
      integer(sequence?.sequence,1);
      await tx.db.query('INSERT INTO core_dispatch.claims '+
        '(request_id,authority_id,device_id,dispatch_id,broker_id,request,sequence,reserved_at_ms,'+
        'reserve_expires_ms,begin_nonce,state) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,\'RESERVED\')',
        [op.requestId,this.authorityId,op.scope.deviceId,dispatchId,broker.brokerId,JSON.stringify(op),
          sequence?.sequence,time,expires,nonce]);
      return this.permit('broker_dispatch_permit_v1',op,broker,dispatchId,nonce,time,expires);
    });
  }
  async commitIfCurrent(value:BrokerDispatchRequest,evidence:ProtectedBrokerEvidence,
    dispatchId:string,nonce:string):Promise<DispatchClaim>{
    const op=frozenRequest(value),broker=Object.freeze(brokerSchema.parse(evidence));
    uuid.parse(dispatchId);nonceSchema.parse(nonce);
    await this.trusted();await this.currentBroker(op,broker);
    return this.transaction(async tx=>{
      await this.grant(tx,op,broker);
      const claim=(await tx.db.query('SELECT * FROM core_dispatch.claims WHERE request_id=$1 FOR UPDATE',
        [op.requestId])).rows[0];
      if(!claim||claim.authority_id!==this.authorityId||claim.dispatch_id!==dispatchId||
        claim.broker_id!==broker.brokerId||!sameRequest(claim.request,op)||claim.state!=='RESERVED')
        fail('DISPATCH_STORE_COMMIT_REPLAY_OR_SCOPE');
      await this.trusted();await this.currentBroker(op,broker);
      const grant=await this.grant(tx,op,broker);
      const time=await tx.now();
      const expires=this.expiry(op,grant,time);
      if(integer(claim?.reserve_expires_ms,1)<=time)fail('DISPATCH_STORE_RESERVATION_EXPIRED');
      await tx.db.query("UPDATE core_dispatch.claims SET state='COMMITTED',commit_nonce=$2,"+
        'commit_expires_ms=$3 WHERE request_id=$1',[op.requestId,nonce,expires]);
      return this.permit('broker_dispatch_commit_v1',op,broker,dispatchId,nonce,time,expires);
    });
  }
  async release(value:DispatchReleaseRequest):Promise<void>{
    const parsed=releaseSchema.parse(value),op=frozenRequest(parsed.request);
    const dispatchId=parsed.dispatchId,brokerId=parsed.brokerId;
    // Revoked credentials must still settle their own original claim; release
    // cannot reauthorize or erase it. The HTTP layer authenticates the Broker.
    await this.trusted();
    await this.transaction(async tx=>{
      const claim=(await tx.db.query('SELECT * FROM core_dispatch.claims WHERE request_id=$1 FOR UPDATE',
        [op.requestId])).rows[0];
      if(!claim||claim.authority_id!==this.authorityId||claim.dispatch_id!==dispatchId||
        claim.broker_id!==brokerId||!sameRequest(claim.request,op)||claim.state==='RELEASED')
        fail('DISPATCH_STORE_RELEASE_SCOPE_OR_REPLAY');
      await tx.db.query("UPDATE core_dispatch.claims SET state='RELEASED' WHERE request_id=$1",[op.requestId]);
    });
  }
  async revokeAndDrain(value:DispatchRevokeRequest,nonce:string):Promise<DispatchClaim>{
    const op=Object.freeze(revokeSchema.parse(value));nonceSchema.parse(nonce);
    if(op.expectedGeneration>=Number.MAX_SAFE_INTEGER)fail('DISPATCH_STORE_GENERATION_EXHAUSTED');
    await this.trusted();
    let approved=false;
    try{approved=await this.verifyRevoke(op)}catch{}
    if(approved!==true)fail('DISPATCH_STORE_OWNER_APPROVAL_REQUIRED');
    // Persist the admission fence BEFORE waiting for a running Broker. No
    // uncertainty or drain timeout may roll this transition back to ACTIVE.
    await this.transaction(async tx=>{
      const row=(await tx.db.query('SELECT * FROM core_dispatch.grants '+
        'WHERE authority_id=$1 AND device_id=$2 FOR UPDATE',[this.authorityId,op.deviceId])).rows[0];
      if(!row||row.state!=='ACTIVE'||row.owner_id!==op.ownerId||row.device_epoch!==op.deviceEpoch||
        row.session_epoch!==op.sessionEpoch||integer(row.generation,1)!==op.expectedGeneration)
        fail('DISPATCH_STORE_REVOKE_STALE');
      await this.trusted();
      await tx.db.query("UPDATE core_dispatch.grants SET state='REVOKING',generation=generation+1,"+
        'core_enabled=false,root_expires_ms=NULL WHERE authority_id=$1 AND device_id=$2',
        [this.authorityId,op.deviceId]);
    });
    const deadline=process.hrtime.bigint()+BigInt(this.drainMs)*1000000n;
    for(;;){
      await this.trusted();
      const completed=await this.transaction(async tx=>{
        const row=(await tx.db.query('SELECT * FROM core_dispatch.grants '+
          'WHERE authority_id=$1 AND device_id=$2 FOR UPDATE',[this.authorityId,op.deviceId])).rows[0];
        if(!row||row.state!=='REVOKING'||row.owner_id!==op.ownerId||row.device_epoch!==op.deviceEpoch||
          row.session_epoch!==op.sessionEpoch||integer(row.generation,1)!==op.expectedGeneration+1)
          fail('DISPATCH_STORE_REVOKE_STALE');
        const pending=(await tx.db.query("SELECT COUNT(*)::bigint AS pending FROM core_dispatch.claims "+
          "WHERE authority_id=$1 AND device_id=$2 AND state='COMMITTED'",
          [this.authorityId,op.deviceId])).rows[0];
        if(integer(pending?.pending)>0)return false;
        let nativeDrained=false;
        try{nativeDrained=await this.verifyDrain(op)}catch{}
        if(nativeDrained!==true)return false;
        await this.trusted();
        await tx.db.query("UPDATE core_dispatch.grants SET state='REVOKED' "+
          'WHERE authority_id=$1 AND device_id=$2',[this.authorityId,op.deviceId]);
        return true;
      });
      if(completed)return this.signed({kind:'broker_dispatch_revocation_v1',authorityId:this.authorityId,
        deviceId:op.deviceId,ownerId:op.ownerId,deviceEpoch:op.deviceEpoch,sessionEpoch:op.sessionEpoch,
        challengeNonce:nonce,previousGeneration:op.expectedGeneration,generation:op.expectedGeneration+1,
        drained:true,revoked:true});
      if(process.hrtime.bigint()>=deadline)fail('DISPATCH_STORE_DRAIN_UNKNOWN');
      await new Promise<void>(resolve=>setTimeout(resolve,25));
    }
  }
}
