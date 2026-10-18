import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,generateKeyPairSync,sign,verify,randomBytes,
} from 'node:crypto';
import {
  signOwnerWssEnrollmentProof,
  type OwnerWssDeviceExternalSigner,
} from '../src/product/owner-public-wss-device-signer-proposal.js';
import {
  serializeOwnerWssDeviceProof,
} from '../src/product/owner-public-wss-device-issuer-proposal.js';

const device='device-secure-001';
const keys=generateKeyPairSync('ed25519');
const pem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const fingerprint=createHash('sha256').update(keys.publicKey.export({
  format:'der',type:'spki',
})).digest('hex');
const proof=()=>({
  deviceId:device,
  nonce:randomBytes(18).toString('base64url'),
  bearerToken:'synthetic-test-only-bearer-for-device',
  signedAtMs:1800000000000,
});
const secureSeam:OwnerWssDeviceExternalSigner={
  deviceId:device,publicKeyPem:pem,
  async signProof(bytes){return sign(null,bytes,keys.privateKey)},
};

test('opaque signer builds issuer-compatible PoP without private key material',async()=>{
  const result=await signOwnerWssEnrollmentProof(
    proof(),secureSeam,fingerprint,
  );
  const {deviceSignature,...unsigned}=result;
  assert.equal(verify(
    null,serializeOwnerWssDeviceProof(unsigned),keys.publicKey,
    Buffer.from(deviceSignature,'base64url'),
  ),true);
  assert.equal(deviceSignature.length,86);
  assert.equal(JSON.stringify(result).includes('PRIVATE KEY'),false);
  assert.equal('privateKeyPem' in result,false);
});

test('wrong device, changed owner SPKI pin and key rotation fail before sign',async()=>{
  let calls=0;
  const signer={
    ...secureSeam,
    async signProof(bytes:Uint8Array){calls++;return secureSeam.signProof(bytes)},
  };
  await assert.rejects(signOwnerWssEnrollmentProof(
    {...proof(),deviceId:'other-device'},signer,fingerprint,
  ),/binding/);
  await assert.rejects(signOwnerWssEnrollmentProof(
    proof(),signer,'a'.repeat(64),
  ),/not the enrolled/);
  const different=generateKeyPairSync('ed25519');
  await assert.rejects(signOwnerWssEnrollmentProof(
    proof(),{...signer,publicKeyPem:different.publicKey.export({
      format:'pem',type:'spki',
    }).toString()},fingerprint,
  ),/not the enrolled/);
  assert.equal(calls,0);
});

test('external signing failure and wrong key handle never yield a proof',async()=>{
  const wrong=generateKeyPairSync('ed25519');
  await assert.rejects(signOwnerWssEnrollmentProof(
    proof(),{...secureSeam,
      async signProof(bytes){return sign(null,bytes,wrong.privateKey)}},
    fingerprint,
  ),/proof invalid/);
  await assert.rejects(signOwnerWssEnrollmentProof(
    proof(),{...secureSeam,
      async signProof(){return new Uint8Array(64)}},
    fingerprint,
  ),/proof invalid/);
  await assert.rejects(signOwnerWssEnrollmentProof(
    proof(),{...secureSeam,
      async signProof(){throw new Error('native signer unavailable')}},
    fingerprint,
  ),/native signer unavailable/);
});

test('unsafe algorithm and invalid nonce are rejected without using signer',async()=>{
  const incompatible=generateKeyPairSync('rsa',{modulusLength:2048});
  let calls=0;
  await assert.rejects(signOwnerWssEnrollmentProof(
    proof(),{...secureSeam,
      publicKeyPem:incompatible.publicKey.export({
        format:'pem',type:'spki',
      }).toString(),
      async signProof(){calls++;return new Uint8Array(64)}},fingerprint,
  ),/Ed25519/);
  await assert.rejects(signOwnerWssEnrollmentProof(
    {...proof(),nonce:'short'},
    {...secureSeam,async signProof(){calls++;return new Uint8Array(64)}},
    fingerprint,
  ),/proof/);
  assert.equal(calls,0);
});
