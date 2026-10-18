import {createHash,createPrivateKey,createPublicKey,
  generateKeyPairSync,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectProtectedSecretFile,readProtectedSecretFile,
  writeProtectedSecretFile,
} from '../security/protected-secret-files.js';
import type {OwnerWssDeviceExternalSigner}
  from './owner-public-wss-device-signer-proposal.js';

/**
 * STAGING ONLY: DPAPI CurrentUser encrypts an Ed25519 PKCS#8 test key
 * ON DISK. The key is decrypted into the Node process to sign. This is
 * NOT a non-exportable CNG or TPM key and never grants Broker authority.
 */
const ID=/^[A-Za-z0-9_:.@-]{8,128}$/;
function purpose(accountId:string,deviceId:string):string{
  if(!ID.test(accountId)||!ID.test(deviceId)){
    throw new Error('Staging device identity invalid');
  }
  const digest=createHash('sha256')
    .update(JSON.stringify([accountId,deviceId])).digest('hex');
  return 'nexowire-wss-ed25519-'+digest;
}
function testFile(file:string):string{
  if(process.platform!=='win32'){
    throw new Error('Windows DPAPI staging requires Windows');
  }
  if(typeof file!=='string'||!path.isAbsolute(file)){
    throw new Error('Absolute staging device-key file required');
  }
  const root=path.resolve(os.tmpdir());
  const value=path.resolve(file);
  const relative=path.relative(root,value);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||
    !value.endsWith('.dpapi.json')){
    throw new Error('Device-key staging path must be inside OS temporary root');
  }
  return value;
}
export async function provisionWindowsDpapiStagingDeviceKey(input:{
  file:string;accountId:string;deviceId:string;
}):Promise<{publicKeyPem:string;deviceKeySpkiSha256:string}>{
  const file=testFile(input.file);
  const label=purpose(input.accountId,input.deviceId);
  // Newly generated test-only key, never read a production key.
  const pair=generateKeyPairSync('ed25519');
  const privatePem=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const publicKeyPem=pair.publicKey.export({format:'pem',type:'spki'}).toString();
  await writeProtectedSecretFile(file,label,privatePem,{
    allowMultiline:true,scope:'current-user',
  }); // Refuses overwrite, encrypts before writing to the temporary file.
  const deviceKeySpkiSha256=createHash('sha256')
    .update(pair.publicKey.export({format:'der',type:'spki'}))
    .digest('hex');
  return {publicKeyPem,deviceKeySpkiSha256};
}
export async function openWindowsDpapiStagingDeviceSigner(input:{
  file:string;accountId:string;deviceId:string;
  /** Must originate from independent owner account/device enrollment. */
  trustedDeviceKeySpkiSha256:string;
}):Promise<OwnerWssDeviceExternalSigner>{
  const file=testFile(input.file);
  const label=purpose(input.accountId,input.deviceId);
  const info=inspectProtectedSecretFile(file);
  if(info.protection!=='windows-dpapi-current-user'||
    info.purpose!==label){
    throw new Error('Staging key scope/purpose does not match enrolled owner/device');
  }
  // Fail if the path has been replaced with a symlink after provisioning.
  const meta=await fs.lstat(file);
  if(!meta.isFile()||meta.isSymbolicLink()){
    throw new Error('Staging device-key file identity invalid');
  }
  const value=readProtectedSecretFile(file,label,'S2 device staging key',{
    allowMultiline:true,
  });
  const key=createPrivateKey(value);
  if(key.type!=='private'||key.asymmetricKeyType!=='ed25519'){
    throw new Error('Staging DPAPI device-key algorithm invalid');
  }
  const publicKey=createPublicKey(key);
  const publicKeyPem=publicKey.export({format:'pem',type:'spki'}).toString();
  const fingerprint=createHash('sha256')
    .update(publicKey.export({format:'der',type:'spki'})).digest('hex');
  if(fingerprint!==input.trustedDeviceKeySpkiSha256){
    throw new Error('Staging DPAPI device key differs from independently enrolled key');
  }
  // Signer returned without any private-key PEM field. The key remains
  // process-accessible through a KeyObject, unlike a real hardware KSP.
  return Object.freeze({
    deviceId:input.deviceId,
    publicKeyPem,
    async signProof(bytes:Uint8Array):Promise<Uint8Array>{
      return sign(null,Buffer.from(bytes),key);
    },
  });
}
