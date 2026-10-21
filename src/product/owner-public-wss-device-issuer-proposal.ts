import {
  createHash,createPrivateKey,createPublicKey,
  verify as verifySignature,sign as signMessage,
} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {StagingAuthenticateToken} from './trusted-owner-quota-authority-proposal.js';
import {
  serializeOwnerPublicWssEnrollment,
  type SignedOwnerPublicWssEnrollment,
} from './owner-public-wss-operator-enrollment-proposal.js';
import {
  validateOwnerPublicWssTrustProfile,
  type OwnerPublicWssTrustProfile,
} from './owner-public-wss-trust-proposal.js';

/** Staging-only device possession request. OAuth bearer is never signed directly. */
export interface DeviceOwnerWssEnrollmentRequest {
  bearerToken:string;
  deviceId:string;
  nonce:string;
  signedAtMs:number;
  deviceSignature:string;
}
export interface OwnerWssIssuerConfig {
  operatorId:string;
  keyId:string;
  operatorPrivateKeyPem:string;
  publicWssProfile:OwnerPublicWssTrustProfile;
  validForMs:number;
  clock?:()=>number;
}
const ID=/^[A-Za-z0-9_:.@-]{8,128}$/;
const NONCE=/^[A-Za-z0-9_-]{22,64}$/;
const SIGNATURE=/^[A-Za-z0-9_-]{86}$/;

/** Canonical bytes the device signs for each fresh request. */
export function serializeOwnerWssDeviceProof(input:Pick<
  DeviceOwnerWssEnrollmentRequest,
  'bearerToken'|'deviceId'|'nonce'|'signedAtMs'
>):Buffer{
  if(!ID.test(input.deviceId) ||
    typeof input.bearerToken!=='string' ||
    input.bearerToken.length<16 || input.bearerToken.length>8192 ||
    !NONCE.test(input.nonce) ||
    !Number.isSafeInteger(input.signedAtMs) || input.signedAtMs<=0){
    throw new Error('Invalid owner WSS device enrollment proof');
  }
  return Buffer.from(JSON.stringify([
    'nexowire.owner-public-wss-device-proof.v1',
    input.deviceId,
    createHash('sha256').update(input.bearerToken,'utf8').digest('hex'),
    input.nonce,input.signedAtMs,
  ]),'utf8');
}

/**
 * STAGING ONLY. MUST run on the operator's already trusted host.
 * No listener or production registration is created.
 * Private operator key is never sent to devices, logs, or repo.
 */
export class ProposedOwnerWssEnrollmentIssuer {
  private readonly key;
  private readonly profile:OwnerPublicWssTrustProfile;
  constructor(
    private readonly db:DatabaseSync,
    private readonly authenticate:StagingAuthenticateToken,
    private readonly config:OwnerWssIssuerConfig,
  ){
    if(!ID.test(config.operatorId)||!ID.test(config.keyId)||
      !Number.isSafeInteger(config.validForMs)||
      config.validForMs<60_000||config.validForMs>24*60*60*1000){
      throw new Error('Invalid operator enrollment issuer configuration');
    }
    this.key=createPrivateKey(config.operatorPrivateKeyPem);
    if(this.key.asymmetricKeyType!=='ed25519'){
      throw new Error('Operator enrollment must use Ed25519 signing');
    }
    const profile=validateOwnerPublicWssTrustProfile(config.publicWssProfile);
    this.profile=Object.freeze({
      endpoint:profile.endpoint,
      expectedHostname:profile.hostname,
      trustedSpkiSha256:Object.freeze([...profile.trustedSpkiSha256]),
      caMode:profile.caMode,
      ...(profile.caMode==='custom'?{trustedCaPem:profile.trustedCaPem}:{}),
    });
  }

  async issue(request:DeviceOwnerWssEnrollmentRequest):
    Promise<SignedOwnerPublicWssEnrollment>{
    // Pin every signed input before the first asynchronous authentication
    // boundary. A shared mutable request must never switch device identity,
    // nonce replay key, token or signature between proof and DB admission.
    const pinned:DeviceOwnerWssEnrollmentRequest={
      bearerToken:request?.bearerToken,deviceId:request?.deviceId,
      nonce:request?.nonce,signedAtMs:request?.signedAtMs,
      deviceSignature:request?.deviceSignature,
    };
    const bytes=serializeOwnerWssDeviceProof(pinned);
    if(!SIGNATURE.test(pinned.deviceSignature)){
      throw new Error('Malformed Ed25519 device possession signature encoding');
    }
    const signatureBytes=Buffer.from(pinned.deviceSignature,'base64url');
    // Reject alternate spellings of the same Ed25519 signature BEFORE
    // owner lookup and before consuming an irreversible nonce.
    if(signatureBytes.length!==64||
      signatureBytes.toString('base64url')!==pinned.deviceSignature){
      throw new Error('Malformed Ed25519 device possession signature encoding');
    }
    const authenticated=await this.authenticate(pinned.bearerToken);
    if(!authenticated||!ID.test(authenticated.accountId)||
      !Number.isSafeInteger(authenticated.sessionGeneration)||
      authenticated.sessionGeneration<0){
      throw new Error('Unverified owner WSS enrollment account');
    }
    const now=(this.config.clock??Date.now)();
    if(!Number.isSafeInteger(now)||now<=0||
      Math.abs(pinned.signedAtMs-now)>60_000){
      throw new Error('Device enrollment proof expired or invalid clock');
    }
    let begun=false;
    try{
      this.db.exec('BEGIN IMMEDIATE');
      begun=true;
      const a=this.db.prepare(
        'SELECT enabled,session_generation FROM proposed_owner_quota_accounts WHERE account_id=?'
      ).get(authenticated.accountId) as {
        enabled:number;session_generation:number
      }|undefined;
      const d=this.db.prepare(
        'SELECT owner_account_id,enabled FROM proposed_owner_quota_devices WHERE device_id=?'
      ).get(pinned.deviceId) as {
        owner_account_id:string;enabled:number
      }|undefined;
      const k=this.db.prepare(
        'SELECT public_key_pem,enabled FROM proposed_owner_rpc_device_keys WHERE device_id=?'
      ).get(pinned.deviceId) as {
        public_key_pem:string;enabled:number
      }|undefined;
      const revision=this.db.prepare(
        'SELECT revision,enabled FROM proposed_owner_wss_profile_revisions WHERE device_id=?'
      ).get(pinned.deviceId) as {
        revision:number;enabled:number
      }|undefined;
      const last=this.db.prepare(
        'SELECT last_seen_ms FROM proposed_owner_quota_account_clock WHERE account_id=?'
      ).get(authenticated.accountId) as {last_seen_ms:number}|undefined;
      if(!a||a.enabled!==1||
        a.session_generation!==authenticated.sessionGeneration||
        !d||d.enabled!==1||d.owner_account_id!==authenticated.accountId||
        !k||k.enabled!==1||!revision||revision.enabled!==1||
        !Number.isSafeInteger(revision.revision)||revision.revision<1||
        (last&&now<last.last_seen_ms)){
        throw new Error('Enrollment denied: owner, session, device or profile revoked');
      }
      const pub=createPublicKey(k.public_key_pem);
      if(pub.asymmetricKeyType!=='ed25519'||
        !verifySignature(null,bytes,pub,
          signatureBytes)){
        throw new Error('Device possession proof invalid');
      }
      // Atomic replay exclusion. A failed signing operation rolls back nonce use.
      this.db.prepare(
        'INSERT INTO proposed_owner_wss_enrollment_nonces(device_id,nonce,consumed_at_ms) VALUES(?,?,?)'
      ).run(pinned.deviceId,pinned.nonce,now);

      const unsigned:SignedOwnerPublicWssEnrollment={
        version:1,operatorId:this.config.operatorId,keyId:this.config.keyId,
        accountId:authenticated.accountId,deviceId:pinned.deviceId,
        sessionGeneration:authenticated.sessionGeneration,
        profileRevision:revision.revision,
        issuedAtMs:now,expiresAtMs:now+this.config.validForMs,
        profile:this.profile,signature:'',
      };
      unsigned.signature=signMessage(
        null,serializeOwnerPublicWssEnrollment(unsigned),this.key,
      ).toString('base64url');
      this.db.prepare(
        'INSERT INTO proposed_owner_quota_account_clock(account_id,last_seen_ms) VALUES(?,?) '+
        'ON CONFLICT(account_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms'
      ).run(authenticated.accountId,now);
      this.db.exec('COMMIT');begun=false;
      return unsigned;
    }catch(error){
      if(begun){
        try{this.db.exec('ROLLBACK')}catch{/* Original error remains authoritative. */}
      }
      throw error;
    }
  }
}
