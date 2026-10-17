import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * DEV/STAGING ONLY: versioned consumer disclosures and separately recorded
 * subscription acknowledgement. Not imported by production GitHub OAuth,
 * checkout, Hub, Worker or Agent. Does not itself grant usage entitlement.
 *
 * KVKK notice DELIVERY is NOT blanket "consent to personal data processing".
 * Optional marketing permission is separately opt-in and never required.
 */
export const DRAFT_DISCLOSURES = Object.freeze({
  version: '2026-10-15-draft-v1',
  supportedTransport: 'openai-secure-mcp-tunnel-default',
  limits: Object.freeze({
    customDailyMin: 100,
    customDailyMax: 850_000,
    sharedTunnelApplicationMinute: 600,
    theoreticalDailyTransportMax: 864_000,
  }),
  usageSummaryTr:
    'Seçtiğiniz günlük kullanım hakkı, Nexowire tool çağrılarınız için bir üst sınırdır; ' +
    'tamamını kullanacağınız veya kesintisiz erişebileceğiniz garanti edilmez. ' +
    'OpenAI Secure MCP Tunnel varsayılanında dakikada 600 MCP isteği sınırı, ' +
    'aynı tünel ve çağıran uygulama kapsamında ortaktır. ' +
    'Kimlik doğrulama, keşif, yeniden deneme ve başka kullanıcıların trafiği ' +
    'kullanılabilir kapasiteyi etkileyebilir. Sağlayıcının hesap/çalışma alanı ' +
    'izinleri ile bilgisayarınızın çevrimiçi olması ayrıca gereklidir.',
  quotaPolicyTr:
    'Custom Usage: günlük 100 ila 850.000 Nexowire mantıksal tool çağrısı. ' +
    'Günlük sayaç UTC gün başlangıcında yenilenir. Aynı mantıksal isteği ' +
    'yeniden göndermek ek kullanım hakkı oluşturmaz. Bu taslak teklifler ' +
    'şu an satışta veya canlıda değildir.',
  legalReviewRequired: true,
} as const);

export type DisclosureFlow = 'signup'|'custom-usage-checkout';
export interface ProposedPurchaseTerms {
  dailyLimit: number;
  priceMinor: number;
  currency: 'TRY'|'USD'|'EUR';
  billingPeriod: 'monthly'|'yearly';
  merchantName: string;
  merchantContact: string;
  cancellationUrl: string;
  termsDocumentVersion: string;
  privacyNoticeVersion: string;
  preInformationVersion: string;
  subscriptionTermsVersion: string;
  locale: 'tr-TR';
}
export interface ProposedSignupTerms {
  termsDocumentVersion: string;
  privacyNoticeVersion: string;
  locale: 'tr-TR';
}
export interface DraftDisclosureOffer {
  subjectId: string;
  flow: DisclosureFlow;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  version: string;
  usageSummaryTr: string;
  quotaPolicyTr: string;
  privacyIsNoticeNotConsent: true;
  marketingConsentOptional: true;
  legalReviewRequired: true;
  purchase?: ProposedPurchaseTerms;
  signup?: ProposedSignupTerms;
}
export interface DraftSignedOffer {
  offer: DraftDisclosureOffer;
  signature: string;
  snapshotHash: string;
}

function id(value:string,field:string):string {
  if(typeof value!=='string'||!/^[A-Za-z0-9_.:@-]{8,128}$/.test(value)) {
    throw new Error('Invalid '+field);
  }
  return value;
}
function nonempty(value:string,name:string):string {
  if(typeof value!=='string'||value.trim().length<3||value.length>256) {
    throw new Error('Missing or invalid '+name);
  }
  return value.trim();
}
function docs(value:string,name:string):string {
  if(typeof value!=='string'||!/^[a-zA-Z0-9._:-]{4,96}$/.test(value)) {
    throw new Error('Invalid version '+name);
  }
  return value;
}
function validatePurchase(input:ProposedPurchaseTerms):ProposedPurchaseTerms{
  const p=input;
  if(!Number.isSafeInteger(p.dailyLimit) ||
    p.dailyLimit<DRAFT_DISCLOSURES.limits.customDailyMin ||
    p.dailyLimit>DRAFT_DISCLOSURES.limits.customDailyMax) {
    throw new Error('Custom usage allowance outside 100..850000');
  }
  if(!Number.isSafeInteger(p.priceMinor)||p.priceMinor<0 ||
    !['TRY','USD','EUR'].includes(p.currency) ||
    !['monthly','yearly'].includes(p.billingPeriod) ||
    p.locale!=='tr-TR')throw new Error('Purchase terms missing validated pricing');
  const cancel=new URL(p.cancellationUrl);
  if(cancel.protocol!=='https:'||cancel.username||cancel.password||
    cancel.search||cancel.hash)throw new Error('Cancellation URL must be HTTPS');
  return {
    ...p,
    merchantName:nonempty(p.merchantName,'merchant name'),
    merchantContact:nonempty(p.merchantContact,'merchant contact'),
    cancellationUrl:cancel.toString(),
    termsDocumentVersion:docs(p.termsDocumentVersion,'terms'),
    privacyNoticeVersion:docs(p.privacyNoticeVersion,'privacy'),
    preInformationVersion:docs(p.preInformationVersion,'preinformation'),
    subscriptionTermsVersion:docs(p.subscriptionTermsVersion,'subscription'),
  };
}
function validateSignup(p:ProposedSignupTerms):ProposedSignupTerms {
  if(p.locale!=='tr-TR')throw new Error('Unsupported language');
  return {...p,
    termsDocumentVersion:docs(p.termsDocumentVersion,'terms'),
    privacyNoticeVersion:docs(p.privacyNoticeVersion,'privacy')};
}
function sha(text:string):string {
  return createHash('sha256').update(text).digest('hex');
}
function hmac(payload:string,secret:string):string{
  if(typeof secret!=='string'||secret.length<32)throw new Error('Server signing secret too short');
  return createHmac('sha256',secret).update(payload).digest('hex');
}
function nowMs(now:Date):number {
  if(!(now instanceof Date)||!Number.isSafeInteger(now.getTime())) {
    throw new Error('Trusted clock invalid');
  }
  return now.getTime();
}
/** Only the trusted server may issue the price/doc snapshot. */
export function issueDraftDisclosureOffer(input:{
  subjectId:string;
  nonce:string;
  flow:DisclosureFlow;
  purchase?:ProposedPurchaseTerms;
  signup?:ProposedSignupTerms;
  now:Date;
  serverSecret:string;
}):DraftSignedOffer{
  const subject=id(input.subjectId,'subject');
  const nonce=id(input.nonce,'offer nonce');
  const issued=nowMs(input.now);
  if(input.flow!=='signup'&&input.flow!=='custom-usage-checkout'){
    throw new Error('Unknown disclosure flow');
  }
  if(input.flow==='signup' ? !input.signup||!!input.purchase
    : !input.purchase||!!input.signup)throw new Error('Invalid flow-specific documents');
  const offer:DraftDisclosureOffer={
    subjectId:subject,flow:input.flow,nonce,
    issuedAt:new Date(issued).toISOString(),
    expiresAt:new Date(issued+15*60_000).toISOString(),
    version:DRAFT_DISCLOSURES.version,
    usageSummaryTr:DRAFT_DISCLOSURES.usageSummaryTr,
    quotaPolicyTr:DRAFT_DISCLOSURES.quotaPolicyTr,
    privacyIsNoticeNotConsent:true,
    marketingConsentOptional:true,
    legalReviewRequired:true,
    ...(input.flow==='signup' ? {signup:validateSignup(input.signup!)}
      : {purchase:validatePurchase(input.purchase!)}),
  };
  const canonical=JSON.stringify(offer);
  return {offer,signature:hmac(canonical,input.serverSecret),
    snapshotHash:sha(canonical)};
}

export interface DraftDisclosureAcceptance {
  /** Explicitly checked by user, not preselected. */
  termsAccepted: boolean;
  /** Separate acknowledgement, only required for checkout. */
  limitsAcknowledged: boolean;
  /** Separate confirmation of price and mandatory distance-sale preinformation. */
  preInformationConfirmed: boolean;
  /** Optional and unchecked by default; NEVER gates login or purchase. */
  optionalMarketingConsent: boolean;
}
export interface DraftRecordedAcceptance {
  subjectId:string;
  flow:DisclosureFlow;
  offerNonce:string;
  version:string;
  snapshotHash:string;
  recordedAt:string;
  optionalMarketingConsent:boolean;
}
export class ProposedDisclosureReceiptStore {
  constructor(private readonly db:DatabaseSync,private readonly secret:string,
    private readonly now:()=>Date=()=>new Date()){}

  record(input:{
    authenticatedSubjectId:string;
    signedOffer:DraftSignedOffer;
    acceptance:DraftDisclosureAcceptance;
  }):DraftRecordedAcceptance {
    const subject=id(input.authenticatedSubjectId,'authenticated subject');
    const currentMs=nowMs(this.now());
    const offer=input.signedOffer.offer;
    if(!offer||offer.subjectId!==subject||offer.version!==DRAFT_DISCLOSURES.version){
      throw new Error('Offer subject or version mismatch');
    }
    const canonical=JSON.stringify(offer);
    const expected=hmac(canonical,this.secret);
    if(typeof input.signedOffer.signature!=='string' ||
      !/^[a-f0-9]{64}$/.test(input.signedOffer.signature) ||
      !timingSafeEqual(Buffer.from(expected,'hex'),
        Buffer.from(input.signedOffer.signature,'hex')) ||
      input.signedOffer.snapshotHash!==sha(canonical)) {
      throw new Error('Signed disclosure snapshot tampered');
    }
    const started=Date.parse(offer.issuedAt),expires=Date.parse(offer.expiresAt);
    if(!Number.isFinite(started)||!Number.isFinite(expires)||
      started>currentMs||expires<currentMs||expires-started!==900000){
      throw new Error('Expired or invalid disclosure offer');
    }
    if(offer.flow==='signup'){
      if(!offer.signup||offer.purchase)throw new Error('Offer flow invalid');
      validateSignup(offer.signup);
    } else if(offer.flow==='custom-usage-checkout'){
      if(!offer.purchase||offer.signup)throw new Error('Offer flow invalid');
      validatePurchase(offer.purchase);
    } else throw new Error('Offer flow invalid');
    if(input.acceptance.termsAccepted!==true){
      throw new Error('Terms must be explicitly accepted');
    }
    if(offer.flow==='custom-usage-checkout' &&
      (input.acceptance.limitsAcknowledged!==true ||
       input.acceptance.preInformationConfirmed!==true)) {
      throw new Error('Plan limits and preinformation must be separately confirmed');
    }
    if(typeof input.acceptance.optionalMarketingConsent!=='boolean'){
      throw new Error('Optional marketing selection must be explicit');
    }
    const receipt:DraftRecordedAcceptance={
      subjectId:subject,flow:offer.flow,offerNonce:offer.nonce,
      version:offer.version,snapshotHash:input.signedOffer.snapshotHash,
      recordedAt:new Date(currentMs).toISOString(),
      optionalMarketingConsent:input.acceptance.optionalMarketingConsent,
    };
    // Repeated server-authenticated confirmation is idempotent for the same
    // immutable snapshot. A stale offer nonce cannot be reused to silently
    // replace the user-visible plan, terms, price or marketing decision.
    const prior=this.db.prepare(
      'SELECT snapshot_hash,recorded_at,marketing_opt_in FROM proposed_disclosure_receipts '+
      'WHERE subject_id=? AND flow=? AND offer_nonce=?',
    ).get(subject,offer.flow,offer.nonce) as
      {snapshot_hash:string;recorded_at:string;marketing_opt_in:number}|undefined;
    if(prior){
      if(prior.snapshot_hash!==receipt.snapshotHash){
        throw new Error('Offer nonce already used with different terms');
      }
      return {...receipt,recordedAt:prior.recorded_at,
        optionalMarketingConsent:prior.marketing_opt_in===1};
    }
    // Draft-only durable receipt; checkout can only begin after separately
    // checking this proof on the same authenticated owner backend.
    this.db.prepare(
      'INSERT INTO proposed_disclosure_receipts '+
      '(subject_id,flow,offer_nonce,version,snapshot_hash,recorded_at,marketing_opt_in) '+
      'VALUES(?,?,?,?,?,?,?)',
    ).run(receipt.subjectId,receipt.flow,receipt.offerNonce,receipt.version,
      receipt.snapshotHash,receipt.recordedAt,Number(receipt.optionalMarketingConsent));
    return receipt;
  }

  /** Read-only. Returns false if no matching current snapshot is stored. */
  hasAccepted(input:{
    subjectId:string;flow:DisclosureFlow;snapshotHash:string;
  }):boolean{
    const row=this.db.prepare(
      'SELECT 1 AS accepted FROM proposed_disclosure_receipts '+
      'WHERE subject_id=? AND flow=? AND snapshot_hash=? LIMIT 1',
    ).get(id(input.subjectId,'subject'),input.flow,input.snapshotHash);
    return Boolean(row);
  }
}
