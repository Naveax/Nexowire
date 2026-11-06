import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {
  type SignedOwnerPublicWssEnrollment,
  type TrustedOwnerPublicWssEnrollmentContext,
  verifySignedOwnerPublicWssEnrollment,
} from './owner-public-wss-operator-enrollment-proposal.js';
import type {OwnerPublicWssTrustProfile}
  from './owner-public-wss-trust-proposal.js';
import {
  ProposedOutboundQuotaWsClient,
  type OutboundQuotaFrame,
  type OutboundQuotaReply,
} from './owner-quota-outbound-ws-proposal.js';

/**
 * DEV/STAGING only. The caller MUST provide fresh, independently
 * authenticated control-plane state for every call. Never source
 * state from MCP arguments, HTTP headers or the signed envelope.
 */
export type TrustedOwnerWssStateReader =
  ()=>Promise<TrustedOwnerPublicWssEnrollmentContext>;

/**
 * STAGING-only durable one-time receipt register.
 * This SQLite database MUST be owned by the trusted operator; never accept
 * a caller-chosen file or database. A receipt is consumed before any socket
 * dial. A failed dial still burns the receipt, to prevent unsafe replay.
 *
 * DDL: proposed_owner_wss_consumed_receipts is created only by the explicit
 * disposable staging fixture/migration. No live schema is changed here.
 */
export class ProposedOwnerWssSqliteReceiptJournal {
  constructor(private readonly db:DatabaseSync) {
    if(!db||typeof db.prepare!=='function'){
      throw new Error('Owner WSS receipt journal unavailable');
    }
  }
  consume(enrollment:Readonly<SignedOwnerPublicWssEnrollment>):void {
    // Enrollment is already verified against an independent owner authority.
    // Include the signer, owner, device and the *canonical signed signature*
    // in the replay identity; a copied receipt cannot change its scope.
    const digest=createHash('sha256').update(JSON.stringify([
      'nexowire.owner-public-wss-receipt-redemption.v1',
      enrollment.operatorId,enrollment.keyId,enrollment.accountId,
      enrollment.deviceId,enrollment.sessionGeneration,
      enrollment.profileRevision,enrollment.signature,
    ])).digest('hex');
    try {
      this.db.prepare(
        'INSERT INTO proposed_owner_wss_consumed_receipts '+
        '(receipt_sha256,operator_id,key_id,account_id,device_id,consumed_at_ms) '+
        'VALUES(?,?,?,?,?,?)'
      ).run(digest,enrollment.operatorId,enrollment.keyId,
        enrollment.accountId,enrollment.deviceId,Date.now());
    } catch {
      // Duplicate, locked DB, missing table or unavailable journal:
      // ALL fail closed. Never retry an uncertain consumption.
      throw new Error('Owner WSS enrollment receipt replay or journal unavailable');
    }
  }
}

/**
 * Once revocation, expiry, stale state or an authority failure is
 * observed, this lease fails closed permanently. No silent reconnect.
 */
export class ProposedOwnerPublicWssEnrollmentLease {
  private invalidated=false;
  private constructor(
    private readonly snapshot:Readonly<SignedOwnerPublicWssEnrollment>,
    private readonly trustedState:TrustedOwnerWssStateReader,
    readonly profile:Readonly<OwnerPublicWssTrustProfile>,
  ){}

  static async establish(
    enrollment:unknown,
    trustedState:TrustedOwnerWssStateReader,
  ):Promise<ProposedOwnerPublicWssEnrollmentLease> {
    if(typeof trustedState!=='function'){
      throw new Error('Missing independent owner WSS trust-state reader');
    }
    const context=await trustedState();
    // Reject before any WSS socket is created.
    const profile=verifySignedOwnerPublicWssEnrollment(enrollment,context);
    const e=enrollment as SignedOwnerPublicWssEnrollment;
    // Snapshot all signed fields and immutable TLS pins. Caller mutation
    // cannot redirect an established enrollment to a different endpoint.
    const snapshot=Object.freeze({
      version:e.version,operatorId:e.operatorId,keyId:e.keyId,
      accountId:e.accountId,deviceId:e.deviceId,
      sessionGeneration:e.sessionGeneration,
      profileRevision:e.profileRevision,
      issuedAtMs:e.issuedAtMs,expiresAtMs:e.expiresAtMs,
      profile,signature:e.signature,
    });
    return new ProposedOwnerPublicWssEnrollmentLease(
      snapshot,trustedState,profile,
    );
  }

  /**
   * Only this entrypoint may authorize a fresh outbound WSS connection.
   * Ordinary establish() is verification-only and cannot itself dial.
   * The operator-controlled SQLite claim is atomic across Hub processes
   * using the same database file; caller must not supply a disposable DB.
   */
  static async establishOnce(
    enrollment:unknown,
    trustedState:TrustedOwnerWssStateReader,
    journal:ProposedOwnerWssSqliteReceiptJournal,
  ):Promise<ProposedOwnerPublicWssEnrollmentLease> {
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
      enrollment,trustedState,
    );
    if(!(journal instanceof ProposedOwnerWssSqliteReceiptJournal)){
      lease.invalidate();
      throw new Error('Owner WSS trusted receipt journal required');
    }
    try{
      journal.consume(lease.snapshot);
      // Owner may revoke/key-rotate while the one-time claim is in flight.
      await lease.requireCurrent();
      return lease;
    }catch(error){
      lease.invalidate();
      throw error;
    }
  }

  async requireCurrent():Promise<void> {
    if(this.invalidated)throw new Error('Owner WSS enrollment lease invalidated');
    try{
      const current=await this.trustedState();
      verifySignedOwnerPublicWssEnrollment(this.snapshot,current);
      // Invalidation may happen while the async authority read runs.
      // A late snapshot must never reactivate an invalidated lease.
      if(this.invalidated){
        throw new Error('Owner WSS enrollment lease invalidated');
      }
    }catch{
      this.invalidated=true;
      throw new Error('Owner WSS enrollment lease expired, revoked or unavailable');
    }
  }

  get deviceId():string{return this.snapshot.deviceId}

  invalidate():void{this.invalidated=true}
}

/**
 * Staging adapter to the existing TLS1.3/CA/SAN/SPKI pinned quota client.
 * The owner server and native Broker still enforce their own authority.
 */
export class ProposedEnrolledOwnerQuotaWsSession {
  private closed=false;
  private constructor(
    private readonly lease:ProposedOwnerPublicWssEnrollmentLease,
    private readonly transport:ProposedOutboundQuotaWsClient,
  ){}

  static async connect(
    enrollment:unknown,
    trustedState:TrustedOwnerWssStateReader,
    journal:ProposedOwnerWssSqliteReceiptJournal,
  ):Promise<ProposedEnrolledOwnerQuotaWsSession>{
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establishOnce(
      enrollment,trustedState,journal,
    );
    try{
      return new ProposedEnrolledOwnerQuotaWsSession(
        lease,new ProposedOutboundQuotaWsClient(lease.profile),
      );
    }catch(e){
      lease.invalidate();
      throw e;
    }
  }

  async reserve(
    frame:OutboundQuotaFrame,timeoutMs=5000,
  ):Promise<OutboundQuotaReply>{
    if(this.closed)throw new Error('Enrolled owner WSS session closed');
    // Reject cross-device routing even before dialing. The owner RPC must
    // still independently verify the complete signed frame and account.
    if(frame?.envelope?.deviceId!==this.lease.deviceId){
      this.close();
      throw new Error('Owner WSS enrollment device binding mismatch');
    }
    try{
      await this.lease.requireCurrent();
      if(this.closed)throw new Error('Enrolled owner WSS session closed');
      // Never retry: a lost response may represent a committed reservation.
      const reply=await this.transport.reserve(frame,timeoutMs);
      if(this.closed)throw new Error('Enrolled owner WSS session closed');
      // The owner can revoke the session while the RPC is in flight. A
      // successful transport reply is NOT an authorization after revocation.
      await this.lease.requireCurrent();
      if(this.closed)throw new Error('Enrolled owner WSS session closed');
      return reply;
    }catch(error){
      this.close(); // Fail closed on uncertain responses/authority failures.
      throw error;
    }
  }
  close():void{
    if(this.closed)return;
    this.closed=true;
    this.lease.invalidate();
    this.transport.close();
  }
}
