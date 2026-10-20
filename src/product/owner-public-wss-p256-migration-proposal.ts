import {
  createHash,createPublicKey,verify as verifySignature,
} from 'node:crypto';

/**
 * STAGING ONLY: separately signed, versioned Ed25519 -> ECDSA P-256
 * migration proof. This does not modify v1 enrollment or authorize any
 * native operation. A verified signature is not a hardware attestation.
 */
export interface ProposedSignedOwnerWssP256Migration {
  version:2;
  signatureAlgorithm:'ecdsa-p256-sha256';
  operatorId:string;
  operatorKeyId:string;
  accountId:string;
  deviceId:string;
  sessionGeneration:number;
  migrationEpoch:number;
  issuedAtMs:number;
  expiresAtMs:number;
  previousEd25519SpkiSha256:string;
  newP256SpkiSha256:string;
  newP256PublicKeyPem:string;
  devicePossessionSignature:string;
  operatorSignature:string;
}
export interface TrustedOwnerWssP256MigrationState {
  operatorId:string;
  operatorKeyId:string;
  operatorPublicKeyPem:string;
  accountId:string;
  deviceId:string;
  activeSessionGeneration:number;
  activeMigrationEpoch:number;
  currentEd25519SpkiSha256:string;
  /** Must come from independently authenticated owner state. */
  requiredProtocolVersion:2;
  nowMs:number;
}
const ID=/^[A-Za-z0-9_:.@-]{8,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const MAX_TTL=10*60_000;
const SKEW=60_000;
const FIELDS=[
  'version','signatureAlgorithm','operatorId','operatorKeyId',
  'accountId','deviceId','sessionGeneration','migrationEpoch',
  'issuedAtMs','expiresAtMs','previousEd25519SpkiSha256',
  'newP256SpkiSha256','newP256PublicKeyPem',
  'devicePossessionSignature','operatorSignature',
] as const;
function strict(value:unknown,fields:readonly string[]):boolean{
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===fields.length&&
    Object.keys(value).every(k=>fields.includes(k));
}
function canonicalB64(value:string,min:number,max:number):Buffer{
  if(typeof value!=='string'||!new RegExp(
    '^[A-Za-z0-9_-]{'+min+','+max+'}$',
  ).test(value))throw new Error('Invalid P256 migration signature encoding');
  const b=Buffer.from(value,'base64url');
  if(b.toString('base64url')!==value){
    throw new Error('Noncanonical P256 migration signature encoding');
  }
  return b;
}
function assertSchema(e:ProposedSignedOwnerWssP256Migration){
  if(!strict(e,FIELDS)||e.version!==2||
    e.signatureAlgorithm!=='ecdsa-p256-sha256'||
    ![e.operatorId,e.operatorKeyId,e.accountId,e.deviceId].every(
      id=>typeof id==='string'&&ID.test(id))||
    !SHA.test(e.previousEd25519SpkiSha256)||
    !SHA.test(e.newP256SpkiSha256)||
    typeof e.newP256PublicKeyPem!=='string'||
    e.newP256PublicKeyPem.length>8192||
    !Number.isSafeInteger(e.sessionGeneration)||e.sessionGeneration<1||
    !Number.isSafeInteger(e.migrationEpoch)||e.migrationEpoch<1||
    !Number.isSafeInteger(e.issuedAtMs)||e.issuedAtMs<1||
    !Number.isSafeInteger(e.expiresAtMs)||e.expiresAtMs<1||
    typeof e.devicePossessionSignature!=='string'||
    typeof e.operatorSignature!=='string'){
    throw new Error('Invalid versioned P256 migration schema');
  }
}
/** Exact bytes signed by the NEW ECDSA P-256 key, including the old pin. */
export function serializeOwnerWssP256MigrationPossession(
  e:ProposedSignedOwnerWssP256Migration,
):Buffer{
  assertSchema(e);
  return Buffer.from(JSON.stringify([
    'nexowire.owner-public-wss.device-key-migration-possession.v2',
    e.version,e.signatureAlgorithm,e.operatorId,e.operatorKeyId,
    e.accountId,e.deviceId,e.sessionGeneration,e.migrationEpoch,
    e.issuedAtMs,e.expiresAtMs,e.previousEd25519SpkiSha256,
    e.newP256SpkiSha256,
  ]),'utf8');
}
/** Operator Ed25519 signature also binds the NEW key possession signature. */
export function serializeOwnerWssP256MigrationApproval(
  e:ProposedSignedOwnerWssP256Migration,
):Buffer{
  const possession=serializeOwnerWssP256MigrationPossession(e);
  return Buffer.from(JSON.stringify([
    'nexowire.owner-public-wss.device-key-migration-approval.v2',
    createHash('sha256').update(possession).digest('hex'),
    e.newP256PublicKeyPem,e.devicePossessionSignature,
  ]),'utf8');
}
export function verifyProposedOwnerWssP256Migration(
  unknownProposal:unknown,
  trusted:TrustedOwnerWssP256MigrationState,
):Readonly<{version:2;algorithm:'ecdsa-p256-sha256';
  deviceId:string;newP256SpkiSha256:string;
  nativeBrokerAuthorized:false;productionAccepted:false}>{
  const e=unknownProposal as ProposedSignedOwnerWssP256Migration;
  assertSchema(e);
  if(!trusted||trusted.requiredProtocolVersion!==2||
    ![trusted.operatorId,trusted.operatorKeyId,trusted.accountId,
      trusted.deviceId].every(id=>typeof id==='string'&&ID.test(id))||
    !SHA.test(trusted.currentEd25519SpkiSha256)||
    typeof trusted.operatorPublicKeyPem!=='string'||
    trusted.operatorPublicKeyPem.length>8192||
    !Number.isSafeInteger(trusted.nowMs)||trusted.nowMs<1||
    !Number.isSafeInteger(trusted.activeSessionGeneration)||
    trusted.activeSessionGeneration<1||
    !Number.isSafeInteger(trusted.activeMigrationEpoch)||
    trusted.activeMigrationEpoch<1){
    throw new Error('Independent owner migration authority missing');
  }
  if(e.operatorId!==trusted.operatorId||
    e.operatorKeyId!==trusted.operatorKeyId||
    e.accountId!==trusted.accountId||
    e.deviceId!==trusted.deviceId||
    e.sessionGeneration!==trusted.activeSessionGeneration||
    e.migrationEpoch!==trusted.activeMigrationEpoch||
    e.previousEd25519SpkiSha256!==trusted.currentEd25519SpkiSha256){
    throw new Error('P256 migration owner/device/session/epoch mismatch');
  }
  if(e.expiresAtMs<=e.issuedAtMs||
    e.expiresAtMs-e.issuedAtMs>MAX_TTL||
    e.issuedAtMs>trusted.nowMs+SKEW||
    trusted.nowMs>=e.expiresAtMs){
    throw new Error('P256 migration expired or invalid trusted clock');
  }
  const next=createPublicKey(e.newP256PublicKeyPem);
  if(next.type!=='public'||next.asymmetricKeyType!=='ec'||
    next.asymmetricKeyDetails?.namedCurve!=='prime256v1'){
    throw new Error('P256 migration key algorithm/curve mismatch');
  }
  const digest=createHash('sha256').update(next.export({
    type:'spki',format:'der',
  })).digest('hex');
  if(digest!==e.newP256SpkiSha256||
    digest===e.previousEd25519SpkiSha256){
    throw new Error('P256 migration next-key SPKI mismatch');
  }
  const ownerKey=createPublicKey(trusted.operatorPublicKeyPem);
  if(ownerKey.type!=='public'||ownerKey.asymmetricKeyType!=='ed25519'){
    throw new Error('Trusted operator issuer must be Ed25519');
  }
  const deviceSig=canonicalB64(e.devicePossessionSignature,80,128);
  const operatorSig=canonicalB64(e.operatorSignature,86,86);
  if(operatorSig.length!==64||
    !verifySignature(null,serializeOwnerWssP256MigrationApproval(e),
      ownerKey,operatorSig)){
    throw new Error('P256 migration operator signature invalid');
  }
  if(!verifySignature('sha256',
    serializeOwnerWssP256MigrationPossession(e),next,deviceSig)){
    throw new Error('P256 migration device possession invalid');
  }
  return Object.freeze({
    version:2,algorithm:'ecdsa-p256-sha256',
    deviceId:e.deviceId,newP256SpkiSha256:e.newP256SpkiSha256,
    nativeBrokerAuthorized:false,productionAccepted:false,
  });
}
