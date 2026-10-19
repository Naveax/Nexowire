import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {
  serializeOwnerWssP256MigrationPossession,
  serializeOwnerWssP256MigrationApproval,
  verifyProposedOwnerWssP256Migration,
  type ProposedSignedOwnerWssP256Migration,
  type TrustedOwnerWssP256MigrationState,
} from '../src/product/owner-public-wss-p256-migration-proposal.js';

const clock=1_800_000_000_000;
const issuer=generateKeyPairSync('ed25519');
const device=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const otherIssuer=generateKeyPairSync('ed25519');
const spki=(k:typeof device.publicKey)=>k.export({
  format:'pem',type:'spki',
}).toString();
const nextHash=createHash('sha256').update(
  device.publicKey.export({format:'der',type:'spki'}),
).digest('hex');
const state:TrustedOwnerWssP256MigrationState={
  operatorId:'owner-operator-01',operatorKeyId:'operator-key-01',
  operatorPublicKeyPem:spki(issuer.publicKey),
  accountId:'account-owner-01',deviceId:'device-p256-01',
  activeSessionGeneration:7,activeMigrationEpoch:12,
  requiredProtocolVersion:2,
  currentEd25519SpkiSha256:'a'.repeat(64),
  nowMs:clock,
};
function signed():ProposedSignedOwnerWssP256Migration{
  const proposal:ProposedSignedOwnerWssP256Migration={
    version:2,signatureAlgorithm:'ecdsa-p256-sha256',
    operatorId:state.operatorId,operatorKeyId:state.operatorKeyId,
    accountId:state.accountId,deviceId:state.deviceId,
    sessionGeneration:state.activeSessionGeneration,
    migrationEpoch:state.activeMigrationEpoch,
    issuedAtMs:clock-1000,expiresAtMs:clock+60_000,
    previousEd25519SpkiSha256:state.currentEd25519SpkiSha256,
    newP256SpkiSha256:nextHash,newP256PublicKeyPem:spki(device.publicKey),
    devicePossessionSignature:'',operatorSignature:'',
  };
  proposal.devicePossessionSignature=sign('sha256',
    serializeOwnerWssP256MigrationPossession(proposal),
    device.privateKey).toString('base64url');
  proposal.operatorSignature=sign(null,
    serializeOwnerWssP256MigrationApproval(proposal),
    issuer.privateKey).toString('base64url');
  return proposal;
}
test('independent owner signed v2 and new P256 key possession verify, but never grant native access',()=>{
  const result=verifyProposedOwnerWssP256Migration(signed(),state);
  assert.equal(result.version,2);
  assert.equal(result.algorithm,'ecdsa-p256-sha256');
  assert.equal(result.newP256SpkiSha256,nextHash);
  assert.equal(result.nativeBrokerAuthorized,false);
  assert.equal(result.productionAccepted,false);
});
test('wrong account, owner, device, generation, old-pin or epoch cannot migrate',()=>{
  const good=signed();
  for(const modified of [
    {operatorId:'foreign-operator'},
    {operatorKeyId:'foreign-key-01'},
    {accountId:'foreign-account'},
    {deviceId:'foreign-device'},
    {activeSessionGeneration:8},
    {activeMigrationEpoch:13},
    {currentEd25519SpkiSha256:'b'.repeat(64)},
  ]){
    assert.throws(()=>verifyProposedOwnerWssP256Migration(
      good,{...state,...modified},
    ),/mismatch/);
  }
});
test('stale signing key / substituted trusted issuer rejects',()=>{
  const good=signed();
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    good,{...state,operatorPublicKeyPem:spki(otherIssuer.publicKey)},
  ),/operator signature/);
  const tampered={...good,newP256SpkiSha256:'b'.repeat(64)};
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    tampered,state,
  ),/SPKI mismatch/);
});
test('P256 possession proof, signing algorithm and downgrade are fail-closed',()=>{
  const good=signed();
  const invalid=structuredClone(good);
  invalid.devicePossessionSignature=sign('sha256',
    Buffer.from('wrong context'),device.privateKey).toString('base64url');
  invalid.operatorSignature=sign(null,
    serializeOwnerWssP256MigrationApproval(invalid),
    issuer.privateKey).toString('base64url');
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    invalid,state,
  ),/possession invalid/);
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    {...good,version:1},state,
  ),/schema/);
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    {...good,signatureAlgorithm:'ed25519'},state,
  ),/schema/);
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    good,{...state,requiredProtocolVersion:1} as unknown as TrustedOwnerWssP256MigrationState,
  ),/authority missing/);
});
test('expiry, future issue, revoked session and rollback epoch deny',()=>{
  const good=signed();
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    good,{...state,nowMs:clock+60_000},
  ),/expired/);
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    good,{...state,nowMs:clock-120_000},
  ),/clock/);
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    good,{...state,activeSessionGeneration:9},
  ),/mismatch/);
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    good,{...state,activeMigrationEpoch:11},
  ),/mismatch/);
});
test('extra fields and wrong key curve are not accepted as operator approval',()=>{
  const good=signed();
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    {...good,unexpected:'field'},state,
  ),/schema/);
  const wrongCurve=generateKeyPairSync('ec',{namedCurve:'secp384r1'});
  const curve=spki(wrongCurve.publicKey);
  const hash=createHash('sha256').update(
    wrongCurve.publicKey.export({format:'der',type:'spki'}),
  ).digest('hex');
  assert.throws(()=>verifyProposedOwnerWssP256Migration(
    {...good,newP256PublicKeyPem:curve,newP256SpkiSha256:hash},state,
  ),/curve mismatch/);
});
