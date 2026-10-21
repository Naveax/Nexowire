import {createHash,verify,type KeyObject} from 'node:crypto';
import type {D1DatabaseLike} from '../product/d1-control-plane-store.js';

const hex64=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id=/^[A-Za-z0-9_.:@-]{1,128}$/;
const version=/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const iso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export interface CoreLocalBootstrap {
  kind:'nexowire.core.local-bootstrap.v1';
  enrollmentId:string;
  deviceId:string;
  ownerAccountId:string;
  credentialHash:string;
  generation:number;
  brokerImageSha256:string;
  brokerVersion:string;
  signerKeySha256:string;
  localConsentEvidenceSha256:string;
  enrolledAt:string;
  /** Claim carried in the transcript; NOT proof of actual Windows UAC. */
  claimedAdminInstalled:true;
  signature:string;
}
export interface NativeBootstrapTrustBoundary {
  /**
   * Only a separately authorized protected native installer may supply these.
   * Source-injected true flags do NOT constitute actual Windows attestation.
   */
  localConsentIndependentlyVerified:boolean;
  elevatedTokenIndependentlyVerified:boolean;
  publisherAndSourceAclVerified:boolean;
  currentOwnerAndDevicePairingVerified:boolean;
  installerRollbackVerified:boolean;
  signingPublicKey:KeyObject;
  expectedDeviceId:string;
  expectedOwnerAccountId:string;
  expectedCredentialHash:string;
  expectedBrokerImageSha256:string;
  expectedBrokerVersion:string;
  trustedNow:Date;
}
export interface CoreDelegationCandidate {
  enrollmentId:string;
  deviceId:string;
  ownerAccountId:string;
  credentialHash:string;
  generation:number;
  brokerImageSha256:string;
  brokerVersion:string;
  signerKeySha256:string;
  localConsentEvidenceSha256:string;
  enrolledAt:string;
  /** Valid source evidence can never itself confer a Windows token. */
  productionPrivilegeAttested:false;
}
function guard(c:boolean,why:string):asserts c {
  if(!c)throw new Error('CORE_DELEGATION_'+why);
}
function body(x:Omit<CoreLocalBootstrap,'signature'>):Buffer{
  return Buffer.from(JSON.stringify([
    x.kind,x.enrollmentId,x.deviceId,x.ownerAccountId,x.credentialHash,
    x.generation,x.brokerImageSha256,x.brokerVersion,x.signerKeySha256,
    x.localConsentEvidenceSha256,x.enrolledAt,x.claimedAdminInstalled,
  ]),'utf8');
}
/** Exported ONLY to generate offline test signed transcripts. */
export function coreBootstrapSigningBytes(
  x:Omit<CoreLocalBootstrap,'signature'>,
):Buffer{return body(x)}
export function verifyCoreBootstrapCandidate(
  raw:CoreLocalBootstrap,
  trust:NativeBootstrapTrustBoundary,
):CoreDelegationCandidate {
  guard(Boolean(raw && typeof raw==='object' && trust && typeof trust==='object'),'INVALID');
  const keys=Object.keys(raw).sort();
  guard(keys.length===13 && keys.join(',')===[
    'brokerImageSha256','brokerVersion','claimedAdminInstalled','credentialHash',
    'deviceId','enrolledAt','enrollmentId','generation','kind',
    'localConsentEvidenceSha256','ownerAccountId','signature','signerKeySha256',
  ].sort().join(','),'FIELDS');
  guard(raw.kind==='nexowire.core.local-bootstrap.v1' &&
    uuid.test(raw.enrollmentId) && id.test(raw.deviceId) &&
    id.test(raw.ownerAccountId) && hex64.test(raw.credentialHash) &&
    Number.isSafeInteger(raw.generation) && raw.generation>=1 &&
    hex64.test(raw.brokerImageSha256) && version.test(raw.brokerVersion) &&
    hex64.test(raw.signerKeySha256) && hex64.test(raw.localConsentEvidenceSha256) &&
    iso.test(raw.enrolledAt) && raw.claimedAdminInstalled===true &&
    /^[A-Za-z0-9_-]{86}$/.test(raw.signature),'SHAPE');
  guard(raw.deviceId===trust.expectedDeviceId &&
    raw.ownerAccountId===trust.expectedOwnerAccountId &&
    raw.credentialHash===trust.expectedCredentialHash &&
    raw.brokerImageSha256===trust.expectedBrokerImageSha256 &&
    raw.brokerVersion===trust.expectedBrokerVersion,'SCOPE_CHANGED');
  guard(trust.localConsentIndependentlyVerified &&
    trust.elevatedTokenIndependentlyVerified &&
    trust.publisherAndSourceAclVerified &&
    trust.currentOwnerAndDevicePairingVerified &&
    trust.installerRollbackVerified,'NATIVE_BOOTSTRAP_UNKNOWN');
  const time=trust.trustedNow.getTime(),issued=Date.parse(raw.enrolledAt);
  guard(Number.isFinite(time)&&Number.isFinite(issued) &&
    issued<=time+5000 && time-issued<=60_000,'CLOCK');
  const key=trust.signingPublicKey;
  guard(Boolean(key?.type==='public'&&key.asymmetricKeyType==='ed25519'),'SIGNER');
  const pinned=createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
  guard(raw.signerKeySha256===pinned,'SIGNER_CHANGED');
  const {signature,...fields}=raw;
  const signatureBytes=Buffer.from(signature,'base64url');
  guard(signatureBytes.length===64 &&
    signatureBytes.toString('base64url')===signature &&
    verify(null,body(fields),key,signatureBytes),'SIGNATURE');
  return Object.freeze({
    enrollmentId:raw.enrollmentId,deviceId:raw.deviceId,
    ownerAccountId:raw.ownerAccountId,credentialHash:raw.credentialHash,
    generation:raw.generation,brokerImageSha256:raw.brokerImageSha256,
    brokerVersion:raw.brokerVersion,signerKeySha256:raw.signerKeySha256,
    localConsentEvidenceSha256:raw.localConsentEvidenceSha256,
    enrolledAt:raw.enrolledAt,productionPrivilegeAttested:false,
  });
}

export class D1CoreDelegationLedger {
  constructor(private readonly db:D1DatabaseLike){}
  /**
   * Writes ONLY candidate enrollment, never a privileged service grant.
   * Database must have migration 0020. Missing schema and bad provenance
   * throw closed; no preference fallback.
   */
  async enroll(candidate:CoreDelegationCandidate,expectedPriorGeneration:number):Promise<boolean>{
    guard(candidate.productionPrivilegeAttested===false &&
      Number.isSafeInteger(expectedPriorGeneration)&&expectedPriorGeneration>=0,
      'LEDGER_INPUT');
    const issued=candidate.enrolledAt;
    const existing=await this.db.prepare(
      'SELECT generation,revoked_at FROM core_admin_delegations WHERE device_id=?',
    ).bind(candidate.deviceId).first<{generation:number;revoked_at:string|null}>();
    if(existing && (existing.generation!==expectedPriorGeneration ||
      existing.revoked_at===null))return false;
    if(!existing && expectedPriorGeneration!==0)return false;
    if(candidate.generation!==expectedPriorGeneration+1)return false;
    const insertSeen=this.db.prepare(
      'INSERT INTO core_admin_consumed_enrollments(enrollment_id,device_id,owner_account_id,consumed_at) VALUES(?,?,?,?) ON CONFLICT(enrollment_id) DO NOTHING',
    ).bind(candidate.enrollmentId,candidate.deviceId,candidate.ownerAccountId,issued);
    const upsert=this.db.prepare(
      `INSERT INTO core_admin_delegations(device_id,owner_account_id,credential_hash,
       generation,enrollment_id,local_broker_identity_sha256,signing_key_sha256,
       bootstrap_proof_sha256,broker_version,enrolled_at,revoked_at)
       SELECT d.id,d.owner_account_id,d.credential_hash,?,?,?,?,?,?,?,NULL
       FROM devices d
       WHERE d.id=? AND d.owner_account_id=? AND d.credential_hash=?
         AND d.access_mode='full' AND d.platform='win32' AND d.privilege_mode='broker'
         AND EXISTS (SELECT 1 FROM device_maintenance_preferences p
           WHERE p.device_id=d.id AND p.owner_account_id=d.owner_account_id AND p.enabled=1)
         AND NOT EXISTS (SELECT 1 FROM core_admin_consumed_enrollments e
           WHERE e.enrollment_id=?)
       ON CONFLICT(device_id) DO UPDATE SET
         owner_account_id=excluded.owner_account_id,credential_hash=excluded.credential_hash,
         generation=excluded.generation,enrollment_id=excluded.enrollment_id,
         local_broker_identity_sha256=excluded.local_broker_identity_sha256,
         signing_key_sha256=excluded.signing_key_sha256,
         bootstrap_proof_sha256=excluded.bootstrap_proof_sha256,
         broker_version=excluded.broker_version,enrolled_at=excluded.enrolled_at,
         revoked_at=NULL
       WHERE core_admin_delegations.generation=? AND
         core_admin_delegations.revoked_at IS NOT NULL`,
    ).bind(
      candidate.generation,candidate.enrollmentId,candidate.brokerImageSha256,
      candidate.signerKeySha256,candidate.localConsentEvidenceSha256,
      candidate.brokerVersion,issued,candidate.deviceId,
      candidate.ownerAccountId,candidate.credentialHash,candidate.enrollmentId,
      expectedPriorGeneration,
    );
    // Upsert precedes the append-only consumed receipt INSIDE the D1 batch
    // transaction. The INSERT predicate blocks stale signed enrollment replay
    // before touching the current generation, even after revocation.
    const changes=await this.db.batch([upsert,insertSeen]);
    return changes[0]?.meta?.changes===1 && changes[1]?.meta?.changes===1;
  }
  async revoke(input:{
    deviceId:string;ownerAccountId:string;enrollmentId:string;
    generation:number;at:string;
  }):Promise<boolean>{
    guard(id.test(input.deviceId)&&id.test(input.ownerAccountId)&&
      uuid.test(input.enrollmentId)&&Number.isSafeInteger(input.generation)&&
      input.generation>=1&&iso.test(input.at),'REVOKE_INPUT');
    const result=await this.db.prepare(
      `UPDATE core_admin_delegations SET revoked_at=?
       WHERE device_id=? AND owner_account_id=? AND enrollment_id=?
         AND generation=? AND revoked_at IS NULL AND enrolled_at<=?`,
    ).bind(input.at,input.deviceId,input.ownerAccountId,input.enrollmentId,
      input.generation,input.at).run();
    return result.meta?.changes===1;
  }
  async currentCandidate(input:{
    deviceId:string;ownerAccountId:string;credentialHash:string;
    brokerImageSha256:string;brokerVersion:string;
  }):Promise<CoreDelegationCandidate|null>{
    guard(id.test(input.deviceId)&&id.test(input.ownerAccountId)&&
      hex64.test(input.credentialHash)&&hex64.test(input.brokerImageSha256)&&
      version.test(input.brokerVersion),'READ_INPUT');
    const row=await this.db.prepare(
      `SELECT c.enrollment_id,c.generation,c.signing_key_sha256,
        c.bootstrap_proof_sha256,c.enrolled_at
       FROM core_admin_delegations c JOIN devices d ON d.id=c.device_id
       WHERE c.device_id=? AND c.owner_account_id=? AND c.credential_hash=?
         AND c.local_broker_identity_sha256=? AND c.broker_version=?
         AND c.revoked_at IS NULL
         AND d.owner_account_id=c.owner_account_id
         AND d.credential_hash=c.credential_hash
         AND d.access_mode='full' AND d.platform='win32'
         AND d.privilege_mode='broker'
         AND EXISTS (SELECT 1 FROM device_maintenance_preferences p
           WHERE p.device_id=d.id AND p.owner_account_id=d.owner_account_id AND p.enabled=1)`,
    ).bind(input.deviceId,input.ownerAccountId,input.credentialHash,
      input.brokerImageSha256,input.brokerVersion).first<{
        enrollment_id:string;generation:number;signing_key_sha256:string;
        bootstrap_proof_sha256:string;enrolled_at:string;
      }>();
    if(!row)return null;
    return Object.freeze({
      enrollmentId:row.enrollment_id,generation:row.generation,
      deviceId:input.deviceId,ownerAccountId:input.ownerAccountId,
      credentialHash:input.credentialHash,brokerImageSha256:input.brokerImageSha256,
      brokerVersion:input.brokerVersion,signerKeySha256:row.signing_key_sha256,
      localConsentEvidenceSha256:row.bootstrap_proof_sha256,
      enrolledAt:row.enrolled_at,productionPrivilegeAttested:false,
    });
  }
}
