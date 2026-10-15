import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  issueDraftDisclosureOffer,
  ProposedDisclosureReceiptStore,
  DRAFT_DISCLOSURES,
  type ProposedPurchaseTerms,
  type DraftDisclosureAcceptance,
} from '../src/product/custom-usage-disclosures-proposal.js';

const secret='test-server-only-hmac-key-32-bytes-minimum-20261015';
const subject='account-verified-111';
const issuedAt=new Date('2026-10-15T15:00:00.000Z');
const purchase:ProposedPurchaseTerms={
  dailyLimit:850_000,
  priceMinor:19900,
  currency:'TRY',
  billingPeriod:'monthly',
  merchantName:'Nexowire Test Merchant (placeholder)',
  merchantContact:'contact@example.test',
  cancellationUrl:'https://example.test/account/cancel',
  termsDocumentVersion:'terms-draft-v1',
  privacyNoticeVersion:'kvkk-draft-v1',
  preInformationVersion:'preinfo-draft-v1',
  subscriptionTermsVersion:'subscription-draft-v1',
  locale:'tr-TR',
};
const accepted:DraftDisclosureAcceptance={
  termsAccepted:true,limitsAcknowledged:true,
  preInformationConfirmed:true,optionalMarketingConsent:false,
};
function f(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(path.join(process.cwd(),
    'test/fixtures/scale-v2-custom-usage-disclosures-dev.sql'),'utf8'));
  const clock={value:new Date('2026-10-15T15:00:30.000Z')};
  const store=new ProposedDisclosureReceiptStore(db,secret,()=>clock.value);
  const signed=issueDraftDisclosureOffer({
    subjectId:subject,nonce:'offer-signature-001',
    flow:'custom-usage-checkout',purchase,now:issuedAt,
    serverSecret:secret,
  });
  return {db,store,clock,signed,close:()=>db.close()};
}

test('full buyer disclosure is bound to quota, price, currency, version and seller',()=>{
  const x=f();try{
    assert.equal(x.signed.offer.purchase?.dailyLimit,850000);
    assert.equal(x.signed.offer.purchase?.priceMinor,19900);
    assert.equal(x.signed.offer.purchase?.merchantName,purchase.merchantName);
    assert.match(x.signed.offer.usageSummaryTr,/600 MCP isteği/);
    assert.match(x.signed.offer.usageSummaryTr,/garanti edilmez/);
    assert.equal(x.signed.offer.privacyIsNoticeNotConsent,true);
    assert.equal(x.signed.offer.marketingConsentOptional,true);
    assert.equal(x.signed.offer.legalReviewRequired,true);
    assert.equal(DRAFT_DISCLOSURES.limits.customDailyMin,100);
    const r=x.store.record({authenticatedSubjectId:subject,
      signedOffer:x.signed,acceptance:accepted});
    assert.equal(r.optionalMarketingConsent,false);
    assert.equal(x.store.hasAccepted({subjectId:subject,
      flow:'custom-usage-checkout',snapshotHash:r.snapshotHash}),true);
  }finally{x.close()}
});

test('checkout refuses empty, default-unchecked or combined consent assumptions',()=>{
  const x=f();try{
    for(const patch of [
      {termsAccepted:false},
      {limitsAcknowledged:false},
      {preInformationConfirmed:false},
    ]){
      assert.throws(()=>x.store.record({authenticatedSubjectId:subject,
        signedOffer:x.signed,acceptance:{...accepted,...patch}}));
    }
    const n=x.db.prepare('SELECT COUNT(*) AS n FROM proposed_disclosure_receipts')
      .get() as {n:number};
    assert.equal(n.n,0);
  }finally{x.close()}
});

test('signup uses terms acceptance only: KVKK notice is presented, not consent checkbox',()=>{
  const x=f();try{
    const signup=issueDraftDisclosureOffer({
      subjectId:subject,nonce:'signup-offer-200',
      flow:'signup',now:issuedAt,serverSecret:secret,
      signup:{
        locale:'tr-TR',termsDocumentVersion:'terms-draft-v1',
        privacyNoticeVersion:'kvkk-draft-v1',
      },
    });
    const r=x.store.record({authenticatedSubjectId:subject,
      signedOffer:signup,
      acceptance:{termsAccepted:true,limitsAcknowledged:false,
        preInformationConfirmed:false,optionalMarketingConsent:false}});
    assert.equal(r.flow,'signup');
    assert.equal(x.store.hasAccepted({subjectId:subject,flow:'signup',
      snapshotHash:signup.snapshotHash}),true);
    assert.equal(x.store.hasAccepted({subjectId:subject,
      flow:'custom-usage-checkout',snapshotHash:signup.snapshotHash}),false);
  }finally{x.close()}
});

test('marketing opt-in stays optional and never gates checkout',()=>{
  const x=f();try{
    const first=x.store.record({authenticatedSubjectId:subject,
      signedOffer:x.signed,acceptance:accepted});
    assert.equal(first.optionalMarketingConsent,false);
    const retry=x.store.record({authenticatedSubjectId:subject,
      signedOffer:x.signed,
      acceptance:{...accepted,optionalMarketingConsent:true}});
    assert.equal(retry.optionalMarketingConsent,false);
    assert.equal(retry.recordedAt,first.recordedAt);
  }finally{x.close()}
});

test('authenticated subject mismatch does not record acceptance',()=>{
  const x=f();try{
    assert.throws(()=>x.store.record({
      authenticatedSubjectId:'different-subject-012',
      signedOffer:x.signed,acceptance:accepted,
    }),/subject/);
    assert.equal(x.store.hasAccepted({subjectId:subject,
      flow:'custom-usage-checkout',snapshotHash:x.signed.snapshotHash}),false);
  }finally{x.close()}
});

test('client tampering with quota, price and legal versions breaks HMAC',()=>{
  const x=f();try{
    for(const alteration of [
      {dailyLimit:100},
      {priceMinor:0},
      {termsDocumentVersion:'terms-faked-version'},
    ]){
      const changed={...x.signed,
        offer:{...x.signed.offer,purchase:{...purchase,...alteration}}};
      assert.throws(()=>x.store.record({
        authenticatedSubjectId:subject,signedOffer:changed,
        acceptance:accepted}),/tampered/);
    }
    assert.equal(x.store.hasAccepted({subjectId:subject,
      flow:'custom-usage-checkout',snapshotHash:x.signed.snapshotHash}),false);
  }finally{x.close()}
});

test('stale offer fails closed and cannot be accepted for checkout',()=>{
  const x=f();try{
    x.clock.value=new Date('2026-10-15T15:16:00.000Z');
    assert.throws(()=>x.store.record({authenticatedSubjectId:subject,
      signedOffer:x.signed,acceptance:accepted}),/Expired/);
  }finally{x.close()}
});

test('untrusted forged signature, invalid hash or missing DB never accepts',()=>{
  const x=f();try{
    for(const signedOffer of [
      {...x.signed,signature:'0'.repeat(64)},
      {...x.signed,snapshotHash:'f'.repeat(64)},
      {...x.signed,signature:'bad'},
    ]) assert.throws(()=>x.store.record({
      authenticatedSubjectId:subject,signedOffer,acceptance:accepted,
    }),/tampered/);
    const missing=new ProposedDisclosureReceiptStore(
      new DatabaseSync(':memory:'),secret,()=>x.clock.value);
    assert.throws(()=>missing.record({authenticatedSubjectId:subject,
      signedOffer:x.signed,acceptance:accepted}),/no such table/);
  }finally{x.close()}
});

test('100 and 850000 allowed, invalid or missing price/seller/cancel rejected',()=>{
  for(const limit of [100,850000])assert.equal(issueDraftDisclosureOffer({
    subjectId:subject,nonce:'new-offer-'+limit,
    flow:'custom-usage-checkout',purchase:{...purchase,dailyLimit:limit},
    now:issuedAt,serverSecret:secret,
  }).offer.purchase?.dailyLimit,limit);
  for(const terms of [
    {...purchase,dailyLimit:850001},
    {...purchase,dailyLimit:99},
    {...purchase,priceMinor:-1},
    {...purchase,merchantName:''},
    {...purchase,cancellationUrl:'http://insecure.example.test/cancel'},
    {...purchase,termsDocumentVersion:''},
  ]){
    assert.throws(()=>issueDraftDisclosureOffer({
      subjectId:subject,nonce:'bad-buy-001',
      flow:'custom-usage-checkout',purchase:terms,
      now:issuedAt,serverSecret:secret,
    }));
  }
});

test('wrong flow documents, brief signing key and malformed timestamps rejected',()=>{
  assert.throws(()=>issueDraftDisclosureOffer({
    subjectId:subject,nonce:'bad-mixed-001',
    flow:'signup',purchase,now:issuedAt,serverSecret:secret,
  }));
  assert.throws(()=>issueDraftDisclosureOffer({
    subjectId:subject,nonce:'bad-mixed-002',
    flow:'custom-usage-checkout',purchase,now:issuedAt,serverSecret:'short',
  }));
  assert.throws(()=>issueDraftDisclosureOffer({
    subjectId:subject,nonce:'bad-clock-003',flow:'signup',
    signup:{termsDocumentVersion:'terms-v1',privacyNoticeVersion:'kvkk-v1',locale:'tr-TR'},
    now:new Date(NaN),serverSecret:secret,
  }));
});

test('same nonce cannot overwrite original receipt with changed price or document',()=>{
  const x=f();try{
    x.store.record({authenticatedSubjectId:subject,
      signedOffer:x.signed,acceptance:accepted});
    const changed=issueDraftDisclosureOffer({
      subjectId:subject,nonce:'offer-signature-001',
      flow:'custom-usage-checkout',
      purchase:{...purchase,priceMinor:99900},
      now:issuedAt,serverSecret:secret,
    });
    assert.throws(()=>x.store.record({
      authenticatedSubjectId:subject,signedOffer:changed,
      acceptance:accepted,
    }),/nonce already used/);
  }finally{x.close()}
});

test('checkout is not granted by a signup receipt with identical account identity',()=>{
  const x=f();try{
    const signed=issueDraftDisclosureOffer({
      subjectId:subject,nonce:'onboarding-v1',flow:'signup',
      signup:{termsDocumentVersion:'terms-v1',privacyNoticeVersion:'kvkk-v1',
        locale:'tr-TR'},now:issuedAt,serverSecret:secret,
    });
    x.store.record({authenticatedSubjectId:subject,signedOffer:signed,
      acceptance:{...accepted,limitsAcknowledged:false,preInformationConfirmed:false}});
    assert.equal(x.store.hasAccepted({subjectId:subject,
      flow:'custom-usage-checkout',snapshotHash:x.signed.snapshotHash}),false);
  }finally{x.close()}
});


test('static UX preview keeps marketing and mandatory checkboxes unchecked and payment disabled',()=>{
  const html=readFileSync(
    path.join(process.cwd(),'web/custom-usage-consent-preview.html'),'utf8');
  const boxes=[...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(x=>x[0]);
  assert.equal(boxes.length,5);
  assert.ok(boxes.every(tag=>!/\bchecked(?:\s|=|>)/i.test(tag)));
  assert.match(html,/disabled aria-disabled="true"/);
  assert.match(html,/600 MCP isteği/);
  assert.match(html,/KVKK aydınlatması/);
  assert.match(html,/Satın alma kapalı/);
  assert.doesNotMatch(html,/fetch\s*\(/);
});

test('unknown DB failures do not return a receipt or silently enable checkout',()=>{
  const x=f();try{
    x.db.exec('DROP TABLE proposed_disclosure_receipts');
    assert.throws(()=>x.store.record({authenticatedSubjectId:subject,
      signedOffer:x.signed,acceptance:accepted}),/no such table/);
  }finally{x.close()}
});
