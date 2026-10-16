import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  issueDraftDisclosureOffer,
  DRAFT_DISCLOSURES,
  type DraftSignedOffer,
  type ProposedPurchaseTerms,
  type DraftDisclosureAcceptance,
  type DraftRecordedAcceptance,
  ProposedDisclosureReceiptStore,
} from './custom-usage-disclosures-proposal.js';

/**
 * DEV/STAGING. A one-shot, server-authoritative pre-checkout gate. Nothing
 * here creates a provider checkout, upgrades the plan or touches production.
 * Callers MUST derive account identity, price catalog and legal approvals
 * from trusted server configuration, never request JSON.
 */
export interface TrustedCurrentCustomOffer {
  purchase: ProposedPurchaseTerms;
  legallyApproved: boolean;
  sandboxCheckoutEnabled: boolean;
}
export interface PreparedDraftCheckoutIntent {
  authenticatedSubjectId: string;
  offerNonce: string;
  snapshotHash: string;
  purchase: ProposedPurchaseTerms;
  reservedAt: string;
  providerCheckoutAllowed: false;
}
function assertTrustedSubject(value:string):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9_.:@-]{8,128}$/.test(value)){
    throw new Error('CHECKOUT_IDENTITY_INVALID');
  }
  return value;
}
function trustedNow(clock:()=>Date):Date{
  const t=clock();
  if(!(t instanceof Date)||!Number.isSafeInteger(t.getTime())){
    throw new Error('CHECKOUT_CLOCK_UNAVAILABLE');
  }
  return t;
}
function requireNonce(nonce:string):string{
  if(typeof nonce!=='string'||!/^[A-Za-z0-9_.:@-]{8,128}$/.test(nonce)){
    throw new Error('CHECKOUT_OFFER_NONCE_INVALID');
  }
  return nonce;
}
function equalPurchase(a:ProposedPurchaseTerms,b:ProposedPurchaseTerms):boolean{
  const keys:(keyof ProposedPurchaseTerms)[]=[
    'dailyLimit','priceMinor','currency','billingPeriod','merchantName',
    'merchantContact','cancellationUrl','termsDocumentVersion',
    'privacyNoticeVersion','preInformationVersion',
    'subscriptionTermsVersion','locale',
  ];
  return keys.every(k=>a[k]===b[k]);
}

export class ProposedOneShotCustomUsageCheckoutGate {
  private readonly receipts:ProposedDisclosureReceiptStore;
  constructor(private readonly db:DatabaseSync,
    private readonly secret:string,
    private readonly clock:()=>Date=()=>new Date()) {
    this.receipts=new ProposedDisclosureReceiptStore(db,secret,clock);
  }

  /** Server issues price/doc/limit snapshot from its current price catalog. */
  issue(input:{
    trustedAuthenticatedSubjectId:string;
    current:TrustedCurrentCustomOffer;
  }):DraftSignedOffer{
    const subject=assertTrustedSubject(input.trustedAuthenticatedSubjectId);
    const at=trustedNow(this.clock);
    // Preview may issue unsigned-to-user quotes before final legal review,
    // but approval NEVER follows until both flags are set and revalidated.
    const signed=issueDraftDisclosureOffer({
      subjectId:subject,nonce:'offer-'+randomUUID(),
      flow:'custom-usage-checkout',purchase:input.current.purchase,
      now:at,serverSecret:this.secret,
    });
    const encoded=JSON.stringify(signed);
    this.db.prepare(
      'INSERT INTO proposed_custom_checkout_offers '+
      '(authenticated_subject_id,offer_nonce,snapshot_hash,signed_offer_json,created_at,expires_at) '+
      'VALUES(?,?,?,?,?,?)',
    ).run(subject,signed.offer.nonce,signed.snapshotHash,encoded,
      signed.offer.issuedAt,signed.offer.expiresAt);
    return signed;
  }

  /**
   * Caller provides only the snapshot hash visible on its actual checkout
   * page and explicitly selected checkboxes; the signed offer is loaded from
   * OWNER DB, never accepted from the browser.
   */
  accept(input:{
    trustedAuthenticatedSubjectId:string;
    offerNonce:string;
    displayedSnapshotHash:string;
    acceptance:DraftDisclosureAcceptance;
  }):DraftRecordedAcceptance{
    const subject=assertTrustedSubject(input.trustedAuthenticatedSubjectId);
    const nonce=requireNonce(input.offerNonce);
    const row=this.db.prepare(
      'SELECT snapshot_hash,signed_offer_json,checkout_reserved_at '+
      'FROM proposed_custom_checkout_offers '+
      'WHERE authenticated_subject_id=? AND offer_nonce=?',
    ).get(subject,nonce) as {
      snapshot_hash:string;signed_offer_json:string;
      checkout_reserved_at:string|null;
    }|undefined;
    if(!row||row.checkout_reserved_at!==null ||
      row.snapshot_hash!==input.displayedSnapshotHash){
      throw new Error('CHECKOUT_DISPLAYED_OFFER_NOT_VERIFIED');
    }
    const signed=JSON.parse(row.signed_offer_json) as DraftSignedOffer;
    return this.receipts.record({
      authenticatedSubjectId:subject,signedOffer:signed,
      acceptance:input.acceptance,
    });
  }

  /**
   * Final pre-provider decision: compare with TODAY'S trusted seller catalog
   * and legal status, require same exact accepted snapshot and reserve once
   * in BEGIN IMMEDIATE. Never open an actual billing provider checkout here.
   */
  reserveSandboxIntent(input:{
    trustedAuthenticatedSubjectId:string;
    offerNonce:string;
    current:TrustedCurrentCustomOffer;
  }):PreparedDraftCheckoutIntent{
    const subject=assertTrustedSubject(input.trustedAuthenticatedSubjectId);
    const nonce=requireNonce(input.offerNonce);
    const now=trustedNow(this.clock);
    if(input.current.legallyApproved!==true||
      input.current.sandboxCheckoutEnabled!==true){
      throw new Error('CHECKOUT_LEGAL_OR_SANDBOX_DISABLED');
    }
    let begun=false;
    try{
      this.db.exec('BEGIN IMMEDIATE');
      begun=true;
      const row=this.db.prepare(
        'SELECT signed_offer_json,snapshot_hash,checkout_reserved_at,expires_at '+
        'FROM proposed_custom_checkout_offers '+
        'WHERE authenticated_subject_id=? AND offer_nonce=?',
      ).get(subject,nonce) as {
        signed_offer_json:string;snapshot_hash:string;
        checkout_reserved_at:string|null;expires_at:string;
      }|undefined;
      if(!row || row.checkout_reserved_at !== null) {
        throw new Error('CHECKOUT_OFFER_NOT_AVAILABLE');
      }
      const signed=JSON.parse(row.signed_offer_json) as DraftSignedOffer;
      const offer=signed.offer;
      if(!offer||offer.flow!=='custom-usage-checkout'||
        offer.version!==DRAFT_DISCLOSURES.version||
        offer.subjectId!==subject||offer.nonce!==nonce||!offer.purchase||
        signed.snapshotHash!==row.snapshot_hash ||
        typeof row.expires_at!=='string' ||
        row.expires_at!==offer.expiresAt ||
        !Number.isFinite(Date.parse(offer.issuedAt)) ||
        !Number.isFinite(Date.parse(row.expires_at)) ||
        Date.parse(offer.issuedAt)>now.getTime() ||
        Date.parse(row.expires_at)<now.getTime()){
        throw new Error('CHECKOUT_OFFER_INVALID_OR_EXPIRED');
      }
      // Check signed bytes AGAIN at actual pre-checkout decision. A corrupted
      // server-side quote record must not be accepted via an older receipt.
      const encoded=JSON.stringify(offer);
      const expectedHash=createHash('sha256').update(encoded).digest('hex');
      const expectedSignature=createHmac('sha256',this.secret)
        .update(encoded).digest('hex');
      if(expectedHash!==row.snapshot_hash ||
        typeof signed.signature!=='string' ||
        !/^[a-f0-9]{64}$/.test(signed.signature) ||
        !timingSafeEqual(Buffer.from(expectedSignature,'hex'),
          Buffer.from(signed.signature,'hex'))) {
        throw new Error('CHECKOUT_SIGNED_QUOTE_INVALID');
      }
      // The receipt was accepted in this same DB by the previously verified
      // HMAC; any missing/superseded documents or price denies approval.
      if(!equalPurchase(offer.purchase,input.current.purchase)){
        throw new Error('CHECKOUT_PRICE_OR_TERMS_CHANGED');
      }
      if(!this.receipts.hasAccepted({
        subjectId:subject,flow:'custom-usage-checkout',
        snapshotHash:row.snapshot_hash,
      })){
        throw new Error('CHECKOUT_CUSTOMER_ACCEPTANCE_REQUIRED');
      }
      const reservedAt=now.toISOString();
      const updated=this.db.prepare(
        'UPDATE proposed_custom_checkout_offers SET checkout_reserved_at=? '+
        'WHERE authenticated_subject_id=? AND offer_nonce=? AND checkout_reserved_at IS NULL',
      ).run(reservedAt,subject,nonce);
      if(updated.changes!==1){
        throw new Error('CHECKOUT_RACE_REJECTED');
      }
      this.db.exec('COMMIT');begun=false;
      return {
        authenticatedSubjectId:subject,offerNonce:nonce,
        snapshotHash:row.snapshot_hash,purchase:offer.purchase,
        reservedAt,providerCheckoutAllowed:false,
      };
    } catch(e){
      if(begun){try{this.db.exec('ROLLBACK')}catch{
        // Unknown database state must NEVER authorize a checkout.
      }}
      throw e;
    }
  }
}
