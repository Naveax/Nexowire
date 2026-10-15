import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ProposedOneShotCustomUsageCheckoutGate,
  type TrustedCurrentCustomOffer,
} from '../src/product/custom-usage-checkout-gate-proposal.js';
import type { DraftDisclosureAcceptance } from
  '../src/product/custom-usage-disclosures-proposal.js';
const secret='staging-checkout-signing-secret-must-be-thirty-two-bytes';
const subject='trusted-subject-0001';
const first=new Date('2026-10-15T14:00:00.000Z');
const complete:DraftDisclosureAcceptance={
  termsAccepted:true,
  limitsAcknowledged:true,
  preInformationConfirmed:true,
  optionalMarketingConsent:false,
};
const current:TrustedCurrentCustomOffer={
  legallyApproved:true,
  sandboxCheckoutEnabled:true,
  purchase:{
    dailyLimit:850_000,priceMinor:599900,currency:'TRY',billingPeriod:'monthly',
    merchantName:'Example seller placeholder',
    merchantContact:'merchant@example.test',
    cancellationUrl:'https://example.test/cancel',
    termsDocumentVersion:'terms-reviewed-v1',
    privacyNoticeVersion:'privacy-reviewed-v1',
    preInformationVersion:'preinfo-reviewed-v1',
    subscriptionTermsVersion:'subscription-reviewed-v1',
    locale:'tr-TR',
  },
};
function setup(){
  const db=new DatabaseSync(':memory:');
  for(const s of [
    'test/fixtures/scale-v2-custom-usage-disclosures-dev.sql',
    'test/fixtures/scale-v2-custom-usage-checkout-gate-dev.sql',
  ])db.exec(readFileSync(path.join(process.cwd(),s),'utf8'));
  const clock={value:first};
  const gate=new ProposedOneShotCustomUsageCheckoutGate(db,secret,()=>clock.value);
  const signed=gate.issue({trustedAuthenticatedSubjectId:subject,current});
  const accept=(overrides:Partial<DraftDisclosureAcceptance>={},
    displayedSnapshotHash=signed.snapshotHash,
    trustedAuthenticatedSubjectId=subject)=>
      gate.accept({trustedAuthenticatedSubjectId,
        offerNonce:signed.offer.nonce,
        displayedSnapshotHash,acceptance:{...complete,...overrides}});
  const reserve=(catalog:TrustedCurrentCustomOffer=current,
    authenticatedSubjectId=subject)=>
      gate.reserveSandboxIntent({
        trustedAuthenticatedSubjectId:authenticatedSubjectId,
        offerNonce:signed.offer.nonce,current:catalog,
      });
  return {gate,db,clock,signed,accept,reserve,close:()=>db.close()};
}

test('accepted exact price+terms authorizes one sandbox intent but never provider checkout',()=>{
  const f=setup();try{
    const receipt=f.accept();
    assert.equal(receipt.subjectId,subject);
    const decision=f.reserve();
    assert.equal(decision.purchase.dailyLimit,850_000);
    assert.equal(decision.purchase.priceMinor,599900);
    assert.equal(decision.providerCheckoutAllowed,false);
    assert.equal(decision.snapshotHash,receipt.snapshotHash);
    assert.throws(()=>f.reserve(),/NOT_AVAILABLE/);
  }finally{f.close()}
});
test('non-accepted offer cannot reserve a checkout',()=>{
  const f=setup();try{
    assert.throws(()=>f.reserve(),/ACCEPTANCE_REQUIRED/);
    assert.equal(f.db.prepare(
      'SELECT checkout_reserved_at AS at FROM proposed_custom_checkout_offers',
    ).get()!.at,null);
  }finally{f.close()}
});
test('terms, limits and preinformation each require explicit checkbox',()=>{
  for(const patch of [{termsAccepted:false},
    {limitsAcknowledged:false},{preInformationConfirmed:false}]){
    const f=setup();try{
      assert.throws(()=>f.accept(patch),/accepted|confirmed/);
      assert.throws(()=>f.reserve(),/ACCEPTANCE_REQUIRED/);
    }finally{f.close()}
  }
});
test('misleading selected quota, price, seller, cancellation or changed legal version blocks',()=>{
  for(const patch of [
    {dailyLimit:100},{priceMinor:0},{currency:'USD'},
    {merchantName:'Different seller'},
    {cancellationUrl:'https://example.test/different'},
    {termsDocumentVersion:'terms-reviewed-v2'},
    {preInformationVersion:'preinfo-reviewed-v2'},
  ]){
    const f=setup();try{
      f.accept();
      assert.throws(()=>f.reserve({...current,
        purchase:{...current.purchase,...patch} as TrustedCurrentCustomOffer['purchase'],
      }),/PRICE_OR_TERMS_CHANGED/);
      assert.equal(f.db.prepare(
        'SELECT checkout_reserved_at AS at FROM proposed_custom_checkout_offers',
      ).get()!.at,null);
    }finally{f.close()}
  }
});
test('legal review off or sandbox flag off never opens an intent',()=>{
  for(const flags of [{legallyApproved:false},{sandboxCheckoutEnabled:false}]){
    const f=setup();try{
      f.accept();
      assert.throws(()=>f.reserve({...current,...flags}),/LEGAL_OR_SANDBOX_DISABLED/);
    }finally{f.close()}
  }
});
test('browser supplied mismatching price snapshot is rejected before receipt storage',()=>{
  const f=setup();try{
    assert.throws(()=>f.accept({},'f'.repeat(64)),/DISPLAYED_OFFER_NOT_VERIFIED/);
    assert.throws(()=>f.reserve(),/ACCEPTANCE_REQUIRED/);
  }finally{f.close()}
});
test('another authenticated user cannot confirm or reserve offer for this account',()=>{
  const f=setup();try{
    assert.throws(()=>f.accept({},f.signed.snapshotHash,'other-subject-0002'),
      /DISPLAYED_OFFER_NOT_VERIFIED/);
    f.accept();
    assert.throws(()=>f.reserve(current,'other-subject-0002'),/NOT_AVAILABLE/);
    assert.equal(f.reserve().authenticatedSubjectId,subject);
  }finally{f.close()}
});
test('expired signed offer cannot confirm or open checkout even if previously accepted',()=>{
  const f=setup();try{
    f.accept();
    f.clock.value=new Date(first.getTime()+15*60_000+1);
    assert.throws(()=>f.reserve(),/INVALID_OR_EXPIRED/);
    const second=setup();try{
      second.clock.value=new Date(first.getTime()+15*60_000+1);
      assert.throws(()=>second.accept(),/Expired/);
    }finally{second.close()}
  }finally{f.close()}
});
test('same accepted offer retries idempotently, no extra checkout intents',()=>{
  const f=setup();try{
    const original=f.accept();
    const retry=f.accept({optionalMarketingConsent:true});
    assert.equal(retry.recordedAt,original.recordedAt);
    assert.equal(retry.optionalMarketingConsent,false);
    f.reserve();
    assert.throws(()=>f.accept(),/DISPLAYED_OFFER_NOT_VERIFIED/);
    assert.throws(()=>f.reserve(),/NOT_AVAILABLE/);
  }finally{f.close()}
});
test('no schema / untrusted clock / bad identity fail closed',()=>{
  const empty=new DatabaseSync(':memory:');
  try{
    const fail=new ProposedOneShotCustomUsageCheckoutGate(
      empty,secret,()=>first);
    assert.throws(()=>fail.issue({
      trustedAuthenticatedSubjectId:subject,current,
    }),/no such table/);
  }finally{empty.close()}
  const f=setup();try{
    assert.throws(()=>f.gate.issue({
      trustedAuthenticatedSubjectId:'invalid subject!',current,
    }),/IDENTITY_INVALID/);
    f.clock.value=new Date(NaN);
    assert.throws(()=>f.reserve(),/CLOCK_UNAVAILABLE/);
  }finally{f.close()}
});
test('two gate instances share one owner database and cannot reserve twice',()=>{
  const f=setup();try{
    f.accept();
    const second=new ProposedOneShotCustomUsageCheckoutGate(f.db,secret,
      ()=>f.clock.value);
    const firstResult=f.reserve();
    assert.equal(firstResult.providerCheckoutAllowed,false);
    assert.throws(()=>second.reserveSandboxIntent({
      trustedAuthenticatedSubjectId:subject,
      offerNonce:f.signed.offer.nonce,current,
    }),/NOT_AVAILABLE/);
  }finally{f.close()}
});
test('corrupted owner DB signed quote fails at final gate even with receipt present',()=>{
  const f=setup();try{
    f.accept();
    const row=f.db.prepare(
      'SELECT signed_offer_json AS signed FROM proposed_custom_checkout_offers',
    ).get() as {signed:string};
    const old=JSON.parse(row.signed);
    old.signature='f'.repeat(64);
    f.db.prepare('UPDATE proposed_custom_checkout_offers SET signed_offer_json=?')
      .run(JSON.stringify(old));
    assert.throws(()=>f.reserve(),/SIGNED_QUOTE_INVALID/);
    assert.equal(f.db.prepare(
      'SELECT checkout_reserved_at AS at FROM proposed_custom_checkout_offers',
    ).get()!.at,null);
  }finally{f.close()}
});

test('reserved intent cannot bypass live billing or activate any account entitlement',()=>{
  const f=setup();try{
    f.accept();
    const snapshot=f.reserve();
    assert.equal(Object.hasOwn(snapshot,'providerCheckoutUrl'),false);
    assert.equal(Object.hasOwn(snapshot,'accountPlanChanged'),false);
    assert.equal(snapshot.providerCheckoutAllowed,false);
  }finally{f.close()}
});
