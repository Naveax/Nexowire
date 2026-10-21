import {verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';

/**
 * Installed native Broker *candidate evidence* for Access #04.
 *
 * Neither a self-inspecting PowerShell token (PR #709) nor a remotely
 * supplied highIntegrity boolean is trustworthy native process evidence.
 * Only a separately enrolled, protected native signer and an independently
 * pinned installed process identity may produce this source assertion.
 * This module does NOT install that signer, inspect OS tokens or dispatch.
 */
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const uid=z.string().uuid();
const processId=z.number().int().positive().max(0xffffffff);
const hexId=z.string().regex(/^[a-f0-9]{16,64}$/);
const filetime=z.string().regex(/^[1-9][0-9]{9,19}$/);
const version=z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);

const nativeRecord=z.strictObject({
  kind:z.literal('nexowire.access.installed-broker-nonce.v1'),
  source:z.literal('protected-installed-broker-process'),
  requestId:uid,challengeNonce:sha,
  ownerId:uid,deviceId:uid,deviceEpoch:uid,sessionEpoch:uid,
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  privilege:z.enum(['CORE','ROOT']),
  brokerPid:processId,creationFiletime:filetime,
  volumeSerialHex:z.string().regex(/^[a-f0-9]{8,16}$/),
  imageFileIdHex:hexId,
  imageSha256:sha,brokerVersion:version,
  nativeTokenIntegrity:z.literal('high'),
  enabledAdministrators:z.literal(true),
  publisherAndReleasePinned:z.literal(true),
  protectedParentImportUpdaterTree:z.literal(true),
  processDupHandleBoundaryVerified:z.literal(true),
  observedAtMs:z.number().int().positive().safe(),
  expiresAtMs:z.number().int().positive().safe(),
});
export type InstalledBrokerNonceRecord=z.infer<typeof nativeRecord>;
export interface SignedInstalledBrokerNonceRecord {
  readonly statement:unknown;
  readonly signature:string;
}
export const installedBrokerSigningBytes=(input:InstalledBrokerNonceRecord):Buffer=>{
  const r=nativeRecord.parse(input);
  return Buffer.from(JSON.stringify([
    r.kind,r.source,r.requestId,r.challengeNonce,
    r.ownerId,r.deviceId,r.deviceEpoch,r.sessionEpoch,r.ownerEpoch,
    r.grantGeneration,r.privilege,r.brokerPid,r.creationFiletime,
    r.volumeSerialHex,r.imageFileIdHex,r.imageSha256,r.brokerVersion,
    r.nativeTokenIntegrity,r.enabledAdministrators,
    r.publisherAndReleasePinned,r.protectedParentImportUpdaterTree,
    r.processDupHandleBoundaryVerified,r.observedAtMs,r.expiresAtMs,
  ]),'utf8');
};
export interface PinnedInstalledBrokerIdentity {
  readonly publicKey:KeyObject;
  /** A process handle identity pinned independently of this signed report. */
  readonly process:{
    pid:number;creationFiletime:string;
    volumeSerialHex:string;imageFileIdHex:string;
    imageSha256:string;brokerVersion:string;
  };
}
export interface InstalledBrokerReviewScope {
  requestId:string;challengeNonce:string;
  ownerId:string;deviceId:string;deviceEpoch:string;sessionEpoch:string;
  ownerEpoch:number;grantGeneration:number;privilege:'CORE'|'ROOT';
  now:number;
}
/**
 * Validate strict signed process identity, protected tree and token claims.
 * It is not a Windows high-token attestation unless signer identity and
 * *actual installed process* have been independently physically accepted.
 */
export function verifiesInstalledBrokerNonce(
  response:SignedInstalledBrokerNonceRecord,
  scope:InstalledBrokerReviewScope,
  pinned:PinnedInstalledBrokerIdentity,
):boolean{
  try{
    const p=nativeRecord.safeParse(response?.statement);
    if(!p.success)return false;
    const r=p.data,key=pinned?.publicKey,expected=pinned?.process;
    if(!key||key.type!=='public'||key.asymmetricKeyType!=='ed25519'||
      !expected||!sha.safeParse(scope.challengeNonce).success||
      r.requestId!==scope.requestId||r.challengeNonce!==scope.challengeNonce||
      r.ownerId!==scope.ownerId||r.deviceId!==scope.deviceId||
      r.deviceEpoch!==scope.deviceEpoch||r.sessionEpoch!==scope.sessionEpoch||
      r.ownerEpoch!==scope.ownerEpoch||
      r.grantGeneration!==scope.grantGeneration||r.privilege!==scope.privilege||
      r.brokerPid!==expected.pid||
      r.creationFiletime!==expected.creationFiletime||
      r.volumeSerialHex!==expected.volumeSerialHex||
      r.imageFileIdHex!==expected.imageFileIdHex||
      r.imageSha256!==expected.imageSha256||
      r.brokerVersion!==expected.brokerVersion||
      !Number.isSafeInteger(scope.now)||r.observedAtMs>scope.now+1000||
      scope.now-r.observedAtMs>5000||
      r.expiresAtMs<=scope.now||
      r.expiresAtMs-r.observedAtMs>5000||
      typeof response?.signature!=='string'||
      !/^[A-Za-z0-9_-]{86}$/.test(response.signature)){
      return false;
    }
    const raw=Buffer.from(response.signature,'base64url');
    return raw.length===64 &&
      raw.toString('base64url')===response.signature &&
      verify(null,installedBrokerSigningBytes(r),key,raw);
  }catch{return false}
}
