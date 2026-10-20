import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verify,createPublicKey,randomBytes} from 'node:crypto';
import {
  openWindowsDpapiStagingDeviceSigner,
  provisionWindowsDpapiStagingDeviceKey,
} from '../src/product/owner-public-wss-windows-dpapi-staging.js';
import {signOwnerWssEnrollmentProof}
  from '../src/product/owner-public-wss-device-signer-proposal.js';
import {serializeOwnerWssDeviceProof}
  from '../src/product/owner-public-wss-device-issuer-proposal.js';

test('Windows current-user DPAPI device identity survives reload, rejects wrong owner/device/pin',
  {skip:process.platform!=='win32'},async()=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-s2-dpapi-'));
    const file=path.join(folder,'device.dpapi.json');
    const accountId='account-stage-test-1',deviceId='device-stage-test-1';
    try{
      const enrolled=await provisionWindowsDpapiStagingDeviceKey({
        file,accountId,deviceId,
      });
      const stored=await fs.readFile(file,'utf8');
      assert.ok(stored.includes('windows-dpapi-current-user'));
      assert.equal(stored.includes('PRIVATE KEY'),false);
      assert.equal(stored.includes('BEGIN PRIVATE'),false);
      await assert.rejects(provisionWindowsDpapiStagingDeviceKey({
        file,accountId,deviceId,
      }),/EXISTS|exists|overwrite/i);
      const handle=await openWindowsDpapiStagingDeviceSigner({
        file,accountId,deviceId,
        trustedDeviceKeySpkiSha256:enrolled.deviceKeySpkiSha256,
      });
      const request={
        bearerToken:'synthetic-secret-for-staging-only-1234',
        deviceId,nonce:randomBytes(18).toString('base64url'),
        signedAtMs:1800000000000,
      };
      const proof=await signOwnerWssEnrollmentProof(
        request,handle,enrolled.deviceKeySpkiSha256,
      );
      assert.equal(verify(
        null,serializeOwnerWssDeviceProof(request),
        createPublicKey(enrolled.publicKeyPem),
        Buffer.from(proof.deviceSignature,'base64url'),
      ),true);
      await assert.rejects(openWindowsDpapiStagingDeviceSigner({
        file,accountId:'another-owner-123',deviceId,
        trustedDeviceKeySpkiSha256:enrolled.deviceKeySpkiSha256,
      }),/purpose|scope/);
      await assert.rejects(openWindowsDpapiStagingDeviceSigner({
        file,accountId,deviceId:'another-device-1',
        trustedDeviceKeySpkiSha256:enrolled.deviceKeySpkiSha256,
      }),/purpose|scope/);
      await assert.rejects(openWindowsDpapiStagingDeviceSigner({
        file,accountId,deviceId,
        trustedDeviceKeySpkiSha256:'a'.repeat(64),
      }),/differs/);
    }finally{
      await fs.rm(folder,{recursive:true,force:true});
    }
  });
