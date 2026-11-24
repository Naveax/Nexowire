import {randomUUID} from 'node:crypto';
import * as z from 'zod';
import {CoreWebAuthnIntentSchema,coreWebAuthnIntentHash,prepareCoreWebAuthnChallenge,
  verifyCoreWebAuthnAssertion,type CoreWebAuthnIntent,type CoreWebAuthnConsumeReceipt,
  type VerifiedCoreWebAuthnAssertion} from './core-webauthn-approval.js';
import {CoreNativeProofSchema,coreNativeWireRequestHash,snapshotCoreNativeWireRequest,
  type CoreNativeProof} from '../protocol/core-native-consent-transport.js';
import type {DispatchStoreConnection,DispatchStorePool}
  from '../agent/postgres-broker-dispatch-authority.js';
import type {IndependentProvenanceCheck} from '../agent/postgres-monotonic-witness.js';

export const CoreApprovalBindingSchema=CoreWebAuthnIntentSchema.omit({challengeId:true,
  rpId:true,credentialId:true,nonce:true,issuedAtMs:true,expiresAtMs:true});
export type CoreApprovalBinding=z.infer<typeof CoreApprovalBindingSchema>;
/** Credential registration survives a fresh logon but never migrates to a
 * different owner/installation/enrollment/SID or owner epoch. The assertion
 * itself still binds every current grant/revoke/logon field. */
export const CoreApprovalCredentialBindingSchema=CoreApprovalBindingSchema.pick({ownerAccountId:true,
  deviceId:true,installationId:true,enrollmentId:true,ownerEpoch:true,windowsUserSid:true});
const issueSchema=CoreWebAuthnIntentSchema.omit({nonce:true,issuedAtMs:true,expiresAtMs:true});
type IssueInput=z.infer<typeof issueSchema>;
export interface CoreApprovalNativeReadback {
  readonly binding:CoreApprovalBinding;
  readonly observedAtMs:number;
  /** Trusted composition must obtain this from the independent native witness,
   * never the approval caller's JSON, software signature or UI state. */
  readonly protectedNativeWitness:true;
  /** From the independently protected local issuer/grant record, NOT from
   * the HTTP expected object or SQL handoff row. Optional for v1 WebAuthn
   * readback; REQUIRED for every v1 enrollment handoff/readback. */
  readonly issuerSpkiSha256?:string;
}
export interface DurableCoreApprovalReceipt extends CoreWebAuthnConsumeReceipt {
  readonly receiptId:string;readonly assertionSha256:string;readonly consumedAtMs:number;
  readonly coreAuthority:false;readonly physicalAcceptance:'NOT_PROVEN';
}
export class CoreApprovalLedgerError extends Error {
  constructor(readonly code:string){super(code);this.name='CoreApprovalLedgerError';}
}
const fail=(code:string):never=>{throw new CoreApprovalLedgerError('CORE_APPROVAL_'+code)};
function integer(value:unknown,min=0):number{
  const n=typeof value==='string'?Number(value):value;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min)fail('STORE_CORRUPT');
  return n as number;
}
function binding(value:unknown):Readonly<CoreApprovalBinding>{
  const source=value as Record<string,unknown>;
  return Object.freeze(CoreApprovalBindingSchema.parse(Object.fromEntries(
    Object.keys(CoreApprovalBindingSchema.shape).map(k=>[k,source[k]]))));
}
function sameBinding(value:unknown,expected:CoreApprovalBinding):boolean{
  const p=CoreApprovalBindingSchema.safeParse(value);
  return p.success&&Object.keys(expected).every(k=>
    (p.data as Record<string,unknown>)[k]===(expected as Record<string,unknown>)[k]);
}
type Tx={db:DispatchStoreConnection;now:()=>Promise<number>};
type Credential=Record<string,unknown>;

/** A real durable conditional consume implementation, not an installed native
 * approval service. It verifies assertions with OPERATOR-PROVISIONED keys in
 * the locked DB, not a caller-provided verified:true object. Independent native
 * and restore witnesses remain required; SQL alone cannot prove either. */
export class PostgresCoreApprovalLedger {
  private readonly authorityId:string;
  private readonly pool:DispatchStorePool;
  private readonly provenance:IndependentProvenanceCheck;
  private readonly native:(expected:Readonly<CoreApprovalBinding>,signal:AbortSignal)=>
    Promise<CoreApprovalNativeReadback|null>;
  constructor(config:{authorityId:string;pool:DispatchStorePool;
    verifyProvenance:IndependentProvenanceCheck;
    readProtectedNativeBinding:(expected:Readonly<CoreApprovalBinding>,signal:AbortSignal)=>
      Promise<CoreApprovalNativeReadback|null>}){
    this.authorityId=z.string().uuid().parse(config.authorityId);
    if(typeof config.pool?.connect!=='function'||typeof config.verifyProvenance!=='function'||
      typeof config.readProtectedNativeBinding!=='function')fail('PROTECTED_CONFIGURATION_REQUIRED');
    this.pool=config.pool;this.provenance=config.verifyProvenance;this.native=config.readProtectedNativeBinding;
  }
  private async bounded<T>(fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      return await Promise.race([Promise.resolve().then(()=>fn(abort.signal)),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
          abort.abort();reject(new CoreApprovalLedgerError('CORE_APPROVAL_WITNESS_UNAVAILABLE'));
        },2000);})]);
    }finally{if(timer)clearTimeout(timer);abort.abort();}
  }
  private async trusted(expected:Readonly<CoreApprovalBinding>,issuerSpkiSha256?:string):Promise<void>{
    let p,n;
    try{
      p=await this.bounded(()=>this.provenance());
      n=await this.bounded(signal=>this.native(expected,signal));
    }catch{return fail('WITNESS_UNAVAILABLE')}
    const now=Date.now();
    if(!p||p.verified!==true||p.authorityId!==this.authorityId||
      !Number.isSafeInteger(p.validUntil)||p.validUntil<=now)fail('PROVENANCE_UNVERIFIED');
    if(!n||n.protectedNativeWitness!==true||!sameBinding(n.binding,expected)||
      !Number.isSafeInteger(n.observedAtMs)||n.observedAtMs>now+1000||n.observedAtMs<now-3000)
      fail('NATIVE_BINDING_UNVERIFIED');
    // The request-supplied issuer must never become "verified" merely because
    // its hex value was persisted in an immutable PostgreSQL row.
    if(issuerSpkiSha256!==undefined&&(!n||n.issuerSpkiSha256!==issuerSpkiSha256))
      fail('ISSUER_UNVERIFIED');
  }
  private async transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>{
    let db:DispatchStoreConnection;
    try{db=await this.pool.connect()}catch{return fail('STORE_UNAVAILABLE')}
    let began=false,committing=false,destroy=false;
    try{
      await db.query('BEGIN');began=true;
      await db.query("SET LOCAL synchronous_commit='on'");
      await db.query("SET LOCAL statement_timeout='5000ms'");
      await db.query("SET LOCAL lock_timeout='3000ms'");
      const s=(await db.query("SELECT current_setting('fsync') AS fsync,"+
        "current_setting('full_page_writes') AS full_page_writes,pg_is_in_recovery() AS recovery,"+
        '(SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication '+
        'FROM pg_roles WHERE rolname=current_user) AS privileged,'+
        "has_schema_privilege(current_user,'core_approval','CREATE') AS ddl,"+
        "has_table_privilege(current_user,'core_approval.challenges','DELETE') AS erase,"+
        "has_table_privilege(current_user,'core_approval.challenges','TRUNCATE') AS truncate_history,"+
        "has_any_column_privilege(current_user,'core_approval.credentials','INSERT') AS provision,"+
        "has_any_column_privilege(current_user,'core_approval.bindings','INSERT') AS enroll,"+
        "has_column_privilege(current_user,'core_approval.credentials','public_key_pem','UPDATE') AS key_rewrite,"+
        "has_column_privilege(current_user,'core_approval.bindings','binding','UPDATE') AS owner_rewrite,"+
        "has_any_column_privilege(current_user,'core_approval.enrollment_consumptions','UPDATE') AS handoff_rewrite,"+
        "has_table_privilege(current_user,'core_approval.enrollment_consumptions','DELETE') AS handoff_erase,"+
        "has_table_privilege(current_user,'core_approval.enrollment_consumptions','TRUNCATE') AS handoff_truncate")).rows[0];
      if(!s||s.fsync!=='on'||s.full_page_writes!=='on'||s.recovery!==false)return fail('DURABILITY_UNVERIFIED');
      if(s.privileged!==false||s.ddl!==false||s.erase!==false||s.truncate_history!==false||
        s.provision!==false||s.enroll!==false||s.key_rewrite!==false||s.owner_rewrite!==false||
        s.handoff_rewrite!==false||s.handoff_erase!==false||s.handoff_truncate!==false)
        fail('ROLE_OVERPRIVILEGED');
      const a=(await db.query('SELECT max_seen_ms FROM core_approval.authorities '+
        'WHERE authority_id=$1 FOR UPDATE',[this.authorityId])).rows[0];
      if(!a)fail('NOT_PROVISIONED');
      let last=integer(a?.max_seen_ms,1);
      const now=async()=>{
        const r=(await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms')).rows[0];
        const ms=integer(r?.now_ms,1);
        if(ms<last)fail('CLOCK_REWIND');last=ms;return ms;
      };
      const result=await fn({db,now});
      await db.query('UPDATE core_approval.authorities SET max_seen_ms=$2 WHERE authority_id=$1',
        [this.authorityId,await now()]);
      committing=true;await db.query('COMMIT');committing=false;began=false;
      return result;
    }catch(error){
      if(committing)destroy=true;
      if(began){try{await db.query('ROLLBACK')}catch{destroy=true}}
      if(error instanceof CoreApprovalLedgerError)throw error;
      // Cryptographic rejection is safe to report; never include DB/secret data.
      if(error instanceof Error&&/^CORE_WEBAUTHN_[A-Z_]+$/.test(error.message))throw error;
      return fail('TRANSACTION_UNKNOWN');
    }finally{db.release(destroy)}
  }
  private async current(tx:Tx,expected:CoreApprovalBinding):Promise<void>{
    const row=(await tx.db.query('SELECT binding,state FROM core_approval.bindings '+
      'WHERE authority_id=$1 AND device_id=$2 FOR UPDATE',[this.authorityId,expected.deviceId])).rows[0];
    if(row?.state!=='ACTIVE'||!sameBinding(row.binding,expected))fail('BINDING_REVOKED_OR_STALE');
  }
  private async credential(tx:Tx,intent:IssueInput):Promise<Credential>{
    const c=(await tx.db.query('SELECT * FROM core_approval.credentials WHERE credential_id=$1 FOR UPDATE',
      [intent.credentialId])).rows[0];
    const pin=CoreApprovalCredentialBindingSchema.safeParse(c?.credential_binding);
    if(!c||!pin.success||!Object.keys(pin.data).every(k=>(pin.data as Record<string,unknown>)[k]===
      (intent as Record<string,unknown>)[k])||c.authority_id!==this.authorityId||c.device_id!==intent.deviceId||
      c.rp_id!==intent.rpId||c.active!==true||typeof c.public_key_pem!=='string'||
      (c.user_handle!==null&&typeof c.user_handle!=='string')||integer(c.signature_counter)>0xffffffff)
      return fail('CREDENTIAL_NOT_PROVISIONED');
    return c;
  }
  async issueChallenge(input:IssueInput):Promise<ReturnType<typeof prepareCoreWebAuthnChallenge>>{
    const original=Object.freeze(issueSchema.parse(input)),expected=binding(original);
    await this.trusted(expected);
    return this.transaction(async tx=>{
      await this.current(tx,expected);await this.credential(tx,original);
      if((await tx.db.query('SELECT challenge_id FROM core_approval.challenges WHERE challenge_id=$1',
        [original.challengeId])).rows.length)fail('CHALLENGE_REPLAY');
      await this.trusted(expected);await this.current(tx,expected);
      const challenge=prepareCoreWebAuthnChallenge(original,await tx.now());
      const i=challenge.intent;
      await tx.db.query('INSERT INTO core_approval.challenges '+
        '(challenge_id,nonce,authority_id,device_id,credential_id,intent,intent_sha256,issued_ms,expires_ms) '+
        'VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)',
        [i.challengeId,i.nonce,this.authorityId,i.deviceId,i.credentialId,JSON.stringify(i),
          challenge.challengeHex,i.issuedAtMs,i.expiresAtMs]);
      return challenge;
    });
  }
  async consumeAssertion(raw:unknown,intentValue:CoreWebAuthnIntent):Promise<Readonly<DurableCoreApprovalReceipt>>{
    const original=snapshotCoreNativeWireRequest({version:1,operation:'approve-and-consume',nonce:randomUUID(),
      expected:{assertion:raw,intent:intentValue}}).expected as {assertion:unknown;intent:CoreWebAuthnIntent};
    const intent=Object.freeze(CoreWebAuthnIntentSchema.parse(original.intent)),expected=binding(intent);
    const started=Date.now(),ticks=process.hrtime.bigint();
    await this.trusted(expected);
    const receipt=await this.transaction(async tx=>{
      await this.current(tx,expected);const c=await this.credential(tx,intent);
      const row=(await tx.db.query('SELECT * FROM core_approval.challenges WHERE challenge_id=$1 FOR UPDATE',
        [intent.challengeId])).rows[0];
      if(!row||row.state!=='ISSUED'||row.authority_id!==this.authorityId||row.device_id!==intent.deviceId||
        row.credential_id!==intent.credentialId||row.nonce!==intent.nonce||
        row.intent_sha256!==coreWebAuthnIntentHash(intent)||
        coreWebAuthnIntentHash(CoreWebAuthnIntentSchema.parse(row.intent))!==row.intent_sha256)
        fail('CHALLENGE_REPLAY_OR_SCOPE');
      const previous=integer(c.signature_counter),verified=verifyCoreWebAuthnAssertion(original.assertion,intent,
        {credentialId:intent.credentialId,publicKeyPem:String(c.public_key_pem),
          userHandle:c.user_handle as string|null,previousSignatureCounter:previous},await tx.now());
      await this.trusted(expected);await this.current(tx,expected);
      const time=await tx.now();
      if(time<intent.issuedAtMs||time>=intent.expiresAtMs)fail('CHALLENGE_EXPIRED');
      const r=this.receipt(verified,randomUUID(),time);
      await tx.db.query('UPDATE core_approval.credentials SET signature_counter=$2 WHERE credential_id=$1',
        [intent.credentialId,verified.nextSignatureCounter]);
      await tx.db.query("UPDATE core_approval.challenges SET state='CONSUMED',receipt_id=$2,"+
        'assertion_sha256=$3,previous_counter=$4,next_counter=$5,consumed_ms=$6,assertion=$7::jsonb WHERE challenge_id=$1',
        [intent.challengeId,r.receiptId,r.assertionSha256,previous,verified.nextSignatureCounter,time,
          JSON.stringify(original.assertion)]);
      return r;
    });
    // Independently read back the committed tombstone with CURRENT native and
    // DB binding. Revocation/readback failure after consume cannot undo it.
    const current=await this.readConsumed(receipt.receiptId,expected);
    // A late or lost acknowledgement must never turn into an actionable receipt.
    // The durable tombstone is retained even when this final check denies it.
    const now=Date.now(),elapsed=process.hrtime.bigint()-ticks;
    if(now<started||now>=intent.expiresAtMs||elapsed<0n||
      elapsed>=BigInt(Math.max(0,intent.expiresAtMs-started))*1000000n)fail('ACK_EXPIRED_OR_UNKNOWN');
    return current;
  }
  private receipt(v:VerifiedCoreWebAuthnAssertion,receiptId:string,time:number):Readonly<DurableCoreApprovalReceipt>{
    return Object.freeze({receiptId,challengeId:v.intent.challengeId,nonce:v.intent.nonce,
      intentSha256:v.intentSha256,assertionSha256:v.assertionSha256,
      credentialSpkiSha256:v.credentialSpkiSha256,previousSignatureCounter:v.previousSignatureCounter,
      nextSignatureCounter:v.nextSignatureCounter,consumedAtMs:time,consumed:true,
      coreAuthority:false,physicalAcceptance:'NOT_PROVEN'});
  }
  /** A fresh scoped readback of an EXISTING consumed record, never a second
   * consume, native human-proof signature or grant. A revoked/re-paired/logged
   * out binding cannot recover an old receipt by knowing its ID. */
  async readConsumed(receiptId:string,value:CoreApprovalBinding):Promise<Readonly<DurableCoreApprovalReceipt>>{
    z.string().uuid().parse(receiptId);const expected=binding(value);
    await this.trusted(expected);
    return this.transaction(async tx=>{
      const {receipt}=await this.stored(tx,receiptId,expected);
      await this.trusted(expected);await this.current(tx,expected);
      return receipt;
    });
  }
  private async stored(tx:Tx,receiptId:string,expected:CoreApprovalBinding){
    await this.current(tx,expected);
    const row=(await tx.db.query('SELECT * FROM core_approval.challenges WHERE receipt_id=$1',
      [receiptId])).rows[0];
    if(!row||row.state!=='CONSUMED'||row.authority_id!==this.authorityId||row.device_id!==expected.deviceId)
      return fail('RECEIPT_UNAVAILABLE');
    const i=CoreWebAuthnIntentSchema.parse(row.intent);
    if(!sameBinding(binding(i),expected)||coreWebAuthnIntentHash(i)!==row.intent_sha256)
      fail('RECEIPT_SCOPE_INVALID');
    const c=await this.credential(tx,i);
    // A database flag/UUID cannot replace the original authenticator bytes.
    // Reverify at the original consume time, then require CURRENT native scope.
    const verified=verifyCoreWebAuthnAssertion(row.assertion,i,
      {credentialId:i.credentialId,publicKeyPem:String(c.public_key_pem),userHandle:c.user_handle as string|null,
        previousSignatureCounter:integer(row.previous_counter)},integer(row.consumed_ms,1));
    if(verified.assertionSha256!==row.assertion_sha256||verified.nextSignatureCounter!==integer(row.next_counter)||
      integer(c.signature_counter)<verified.nextSignatureCounter)fail('RECEIPT_CRYPTOGRAPHY_INVALID');
    const receipt=this.receipt(verified,receiptId,integer(row.consumed_ms,1));
    const proof=Object.freeze(CoreNativeProofSchema.parse({...binding(i),challengeId:i.challengeId,
      receiptId,approvedAtMs:receipt.consumedAtMs,consumed:true}));
    return {receipt,proof};
  }
  /** Second, independent one-use stage for the D1 enrollment verifier. Readback
   * of the first WebAuthn consume is deliberately NOT this authorization.
   * There is no successful retry after a lost/late COMMIT acknowledgement. */
  async consumeForEnrollment(value:CoreNativeProof,issuerSpkiSha256:string):Promise<Readonly<CoreNativeProof>>{
    const proof=Object.freeze(CoreNativeProofSchema.parse(value)),expected=binding(proof);
    const issuer=z.string().regex(/^[a-f0-9]{64}$/).parse(issuerSpkiSha256);
    const started=Date.now(),ticks=process.hrtime.bigint();
    await this.trusted(expected,issuer);
    await this.transaction(async tx=>{
      const stored=await this.stored(tx,proof.receiptId,expected);
      if(!Object.keys(proof).every(k=>proof[k as keyof CoreNativeProof]===stored.proof[k as keyof CoreNativeProof]))
        fail('ENROLLMENT_PROOF_MISMATCH');
      await this.current(tx,expected);
      const time=await tx.now();
      if(time<proof.approvedAtMs||time-proof.approvedAtMs>=120000)fail('ENROLLMENT_PROOF_EXPIRED');
      // The DB lock and clock query both await I/O. Revalidate the protected
      // native issuer/scope AFTER those awaits, just before the irrevocable
      // one-use INSERT, not before an intervening mutable readback.
      await this.trusted(expected,issuer);
      const inserted=await tx.db.query('INSERT INTO core_approval.enrollment_consumptions '+
        '(receipt_id,authority_id,device_id,proof_sha256,issuer_spki_sha256,consumed_ms) '+
        'VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(receipt_id) DO NOTHING RETURNING receipt_id',
        [proof.receiptId,this.authorityId,proof.deviceId,this.proofHash(proof),issuer,time]);
      if(inserted.rows.length!==1)fail('ENROLLMENT_REPLAY');
    });
    // A post-commit revoke/readback failure consumes the authorization but never
    // grants it. The tombstone cannot be reopened by another service instance.
    const current=await this.readEnrollmentProof(proof.receiptId,expected);
    const now=Date.now(),elapsed=process.hrtime.bigint()-ticks;
    if(now<started||now-proof.approvedAtMs>=120000||elapsed<0n||
      elapsed>=BigInt(Math.max(0,proof.approvedAtMs+120000-started))*1000000n)
      fail('ENROLLMENT_ACK_EXPIRED_OR_UNKNOWN');
    return current;
  }
  private proofHash(proof:CoreNativeProof):string{
    // Existing domain-separated canonical request hashing, no mutable caller
    // JSON or ambiguous object property order in the permanent handoff record.
    return coreNativeWireRequestHash({version:1,operation:'verify-and-consume',
      nonce:proof.challengeId,expected:proof});
  }
  /** Only already-consumed enrollment handoffs can be read here. The proof is
   * reconstructed from the stored signed assertion, not from an HTTP request. */
  async readEnrollmentProof(receiptId:string,value:CoreApprovalBinding):Promise<Readonly<CoreNativeProof>>{
    z.string().uuid().parse(receiptId);const expected=binding(value);
    await this.trusted(expected);
    return this.transaction(async tx=>{
      const {proof}=await this.stored(tx,receiptId,expected);
      const row=(await tx.db.query('SELECT authority_id,device_id,proof_sha256,issuer_spki_sha256,consumed_ms '+
        'FROM core_approval.enrollment_consumptions WHERE receipt_id=$1',[receiptId])).rows[0];
      // Narrow the untrusted DB column independently. A caller-selected or
      // unknown-typed issuer must never enter the protected witness comparison.
      const storedIssuer=row?.issuer_spki_sha256;
      if(typeof storedIssuer!=='string')
        throw new CoreApprovalLedgerError('CORE_APPROVAL_ENROLLMENT_NOT_CONSUMED');
      if(!/^[a-f0-9]{64}$/.test(storedIssuer))
        throw new CoreApprovalLedgerError('CORE_APPROVAL_ENROLLMENT_NOT_CONSUMED');
      if(!row||row.authority_id!==this.authorityId||row.device_id!==expected.deviceId||
        row.proof_sha256!==this.proofHash(proof)||integer(row.consumed_ms,1)<proof.approvedAtMs)
        fail('ENROLLMENT_NOT_CONSUMED');
      // Reconcile the durable issuer tombstone with a fresh independent native
      // readback. Native issuer rotation/revoke may deny but never undo consume.
      await this.trusted(expected,storedIssuer);await this.current(tx,expected);
      return proof;
    });
  }
}
