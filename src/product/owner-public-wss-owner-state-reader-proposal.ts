import {createHash,createPublicKey,timingSafeEqual}
  from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {TrustedOwnerPublicWssEnrollmentContext}
  from './owner-public-wss-operator-enrollment-proposal.js';
import type {TrustedOwnerWssStateReader}
  from './owner-public-wss-enrollment-lease-proposal.js';

interface BoundOwnerReaderConfig {
  /** Pinned from an independent operator-controlled configuration. */
  operatorId:string;
  keyId:string;
  operatorPublicKeyPem:string;
  /** Bound to the authenticated account and physical device identity. */
  accountId:string;
  deviceId:string;
  /** SPKI SHA-256 of the originally enrolled device key, pinned independently. */
  deviceKeySpkiSha256:string;
  nowMs?:()=>number;
}
type OwnerStateRow={
  account_enabled:number;
  session_generation:number;
  owner_account_id:string|null;
  device_enabled:number|null;
  device_key_enabled:number|null;
  public_key_pem:string|null;
  revision_enabled:number|null;
  revision:number|null;
  last_seen_ms:number|null;
};
const ID=/^[A-Za-z0-9_:.@-]{8,128}$/;
const SHA256=/^[a-f0-9]{64}$/;

/**
 * STAGING ONLY. Read live owner-controlled local SQLite authority state
 * BEFORE each WSS reservation through the signed enrollment lease.
 *
 * This reader is not a remote authenticated control-plane protocol.
 * NEVER install it against customer-controlled files to meter SaaS.
 */
export function createOwnerWssSqliteTrustedStateReader(
  db:DatabaseSync,
  config:BoundOwnerReaderConfig,
):TrustedOwnerWssStateReader{
  if(!db||typeof db.prepare!=='function'||
    !ID.test(config.operatorId)||!ID.test(config.keyId)||
    !ID.test(config.accountId)||!ID.test(config.deviceId)||
    !SHA256.test(config.deviceKeySpkiSha256)||
    typeof config.operatorPublicKeyPem!=='string'||
    config.operatorPublicKeyPem.length>8192){
    throw new Error('Owner WSS trusted state reader configuration invalid');
  }
  const operatorKey=createPublicKey(config.operatorPublicKeyPem);
  if(operatorKey.type!=='public'||operatorKey.asymmetricKeyType!=='ed25519'){
    throw new Error('Owner WSS operator verification key must be Ed25519');
  }
  const operatorPublicKeyPem=operatorKey.export({
    format:'pem',type:'spki',
  }).toString();
  const expectedDeviceFingerprint=Buffer.from(config.deviceKeySpkiSha256,'hex');
  return async():Promise<TrustedOwnerPublicWssEnrollmentContext>=>{
    // One coherent SQLite SELECT to avoid separate row lookups observing
    // inconsistent account/device/key/revision combinations.
    const row=db.prepare(
      'SELECT a.enabled AS account_enabled, '+
      'a.session_generation, d.owner_account_id, '+
      'd.enabled AS device_enabled, k.enabled AS device_key_enabled, '+
      'k.public_key_pem, r.enabled AS revision_enabled, r.revision, '+
      'c.last_seen_ms '+
      'FROM proposed_owner_quota_accounts AS a '+
      'LEFT JOIN proposed_owner_quota_devices AS d ON d.device_id=? '+
      'LEFT JOIN proposed_owner_rpc_device_keys AS k ON k.device_id=d.device_id '+
      'LEFT JOIN proposed_owner_wss_profile_revisions AS r ON r.device_id=d.device_id '+
      'LEFT JOIN proposed_owner_quota_account_clock AS c ON c.account_id=a.account_id '+
      'WHERE a.account_id=?',
    ).get(config.deviceId,config.accountId) as OwnerStateRow|undefined;
    const now=(config.nowMs??Date.now)();
    if(!Number.isSafeInteger(now)||now<=0||
      !row||row.account_enabled!==1||
      row.owner_account_id!==config.accountId||
      row.device_enabled!==1||row.device_key_enabled!==1||
      row.revision_enabled!==1||
      !Number.isSafeInteger(row.session_generation)||
      row.session_generation<=0||
      !Number.isSafeInteger(row.revision)||row.revision===null||
      row.revision<=0||
      (row.last_seen_ms!==null && (
        !Number.isSafeInteger(row.last_seen_ms) ||
        now<row.last_seen_ms
      ))||
      typeof row.public_key_pem!=='string'||
      row.public_key_pem.length>8192){
      throw new Error('Trusted owner WSS account, device or state revoked');
    }
    const devicePublicKey=createPublicKey(row.public_key_pem);
    if(devicePublicKey.type!=='public'||
      devicePublicKey.asymmetricKeyType!=='ed25519'){
      throw new Error('Trusted owner WSS device signing key invalid');
    }
    const currentFingerprint=createHash('sha256')
      .update(devicePublicKey.export({format:'der',type:'spki'}))
      .digest();
    if(!timingSafeEqual(currentFingerprint,expectedDeviceFingerprint)){
      throw new Error('Trusted owner WSS device signing key rotated');
    }
    return Object.freeze({
      operatorId:config.operatorId,keyId:config.keyId,
      operatorPublicKeyPem,accountId:config.accountId,
      deviceId:config.deviceId,
      activeSessionGeneration:row.session_generation,
      minimumProfileRevision:row.revision,nowMs:now,
    });
  };
}
