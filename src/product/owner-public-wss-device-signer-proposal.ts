import {
  createHash,createPublicKey,timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import {
  serializeOwnerWssDeviceProof,
  type DeviceOwnerWssEnrollmentRequest,
} from './owner-public-wss-device-issuer-proposal.js';

/**
 * STAGING contract for a platform-kept signing handle.
 *
 * This interface never accepts a private-key PEM or PKCS#8 byte array. A
 * production implementation MUST independently verify that the native OS
 * provider protects access under the correct local device/Agent identity.
 * Passing an ordinary in-process Ed25519 key here does NOT prove CNG/TPM.
 */
export interface OwnerWssDeviceExternalSigner {
  readonly deviceId:string;
  /** Public SPKI only. This key is compared against a separately pinned hash. */
  readonly publicKeyPem:string;
  /** External signer signs exactly the canonical enrollment proof bytes. */
  signProof(canonicalBytes:Uint8Array):Promise<Uint8Array>;
}

const SHA256=/^[a-f0-9]{64}$/;
type UnsignedProof=Pick<DeviceOwnerWssEnrollmentRequest,
  'bearerToken'|'deviceId'|'nonce'|'signedAtMs'>;

/**
 * Build an issuer-compatible device PoP without moving a private key into
 * JavaScript. Caller must obtain the expected SPKI hash from the already
 * authenticated owner enrollment record, NEVER from caller/tool arguments.
 *
 * Local Ed25519 verification detects wrong handles/rotation before network
 * send. The issuer still enforces nonce uniqueness and authoritative state.
 */
export async function signOwnerWssEnrollmentProof(
  proof:UnsignedProof,
  signer:OwnerWssDeviceExternalSigner,
  trustedDeviceSpkiSha256:string,
):Promise<DeviceOwnerWssEnrollmentRequest>{
  // Snapshot every signed field before any asynchronous signer boundary.
  // The callback can outlive the calling code's mutable request object.
  const bound:UnsignedProof={
    bearerToken:proof?.bearerToken,
    deviceId:proof?.deviceId,
    nonce:proof?.nonce,
    signedAtMs:proof?.signedAtMs,
  };
  if(!signer||typeof signer.deviceId!=='string'||
    signer.deviceId!==bound.deviceId||
    typeof signer.publicKeyPem!=='string'||
    signer.publicKeyPem.length>8192||
    typeof signer.signProof!=='function'||
    !SHA256.test(trustedDeviceSpkiSha256)){
    throw new Error('Owner WSS secure signer device binding invalid');
  }
  const publicKey=createPublicKey(signer.publicKeyPem);
  if(publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519'){
    throw new Error('Owner WSS signer requires Ed25519 public SPKI');
  }
  const actual=createHash('sha256')
    .update(publicKey.export({format:'der',type:'spki'})).digest();
  const expected=Buffer.from(trustedDeviceSpkiSha256,'hex');
  if(!timingSafeEqual(actual,expected)){
    throw new Error('Owner WSS secure signer is not the enrolled device key');
  }
  const canonical=serializeOwnerWssDeviceProof(bound);
  const raw=await signer.signProof(Buffer.from(canonical));
  if(!(raw instanceof Uint8Array)||raw.byteLength!==64||
    !verifySignature(null,canonical,publicKey,raw)){
    throw new Error('Owner WSS external device signing proof invalid');
  }
  return {
    bearerToken:bound.bearerToken,deviceId:bound.deviceId,
    nonce:bound.nonce,signedAtMs:bound.signedAtMs,
    deviceSignature:Buffer.from(raw).toString('base64url'),
  };
}
