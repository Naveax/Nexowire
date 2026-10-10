import {createHash,sign,verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import {
  AdminBridgeModeIntentSchema,
  validateAdminBridgeModeIntent,
  type AdminBridgeModeIntent,
} from './admin-bridge-intent.js';

const hexDigest=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const signature=z.string().regex(/^[A-Za-z0-9_-]{86}$/);

export const GuardianHubCommandBodySchema=z.strictObject({
  type:z.literal('guardian.hub-bridge-command'),
  version:z.literal(1),
  intent:AdminBridgeModeIntentSchema,
  ownerPreferenceRevision:revision,
  guardianKeyId:hexDigest,
  hubSignerKeyId:hexDigest,
});
export const GuardianHubSignedCommandSchema=GuardianHubCommandBodySchema.extend({
  signature,
});
export type GuardianHubCommandBody=z.infer<typeof GuardianHubCommandBodySchema>;

export function hubCommandPublicKeyId(publicKey:KeyObject):string {
  if(publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519'){
    throw new Error('GUARDIAN_HUB_COMMAND_PUBLIC_KEY_UNTRUSTED');
  }
  return createHash('sha256')
    .update(publicKey.export({type:'spki',format:'der'})).digest('hex');
}

/** Fixed-order domain-separated transcript, never arbitrary JSON key order. */
export function guardianHubCommandBytes(raw:GuardianHubCommandBody):Buffer {
  const data=GuardianHubCommandBodySchema.parse(raw);
  const i=data.intent;
  return Buffer.from(JSON.stringify([
    'nexowire.guardian.hub-bridge-command.v1',
    data.type,data.version,
    i.type,i.version,i.requestId,i.deviceId,i.ownerAccountId,
    i.credentialBinding,i.desiredMode,i.issuedAt,i.expiresAt,
    data.ownerPreferenceRevision,data.guardianKeyId,data.hubSignerKeyId,
  ]),'utf8');
}

/** Test/protected Hub utility. The signer must never be sent to a device. */
export function signGuardianHubCommand(
  raw:GuardianHubCommandBody,protectedHubPrivateKey:KeyObject,
):z.infer<typeof GuardianHubSignedCommandSchema> {
  if(protectedHubPrivateKey.type!=='private'||
      protectedHubPrivateKey.asymmetricKeyType!=='ed25519'){
    throw new Error('GUARDIAN_HUB_COMMAND_PRIVATE_KEY_UNTRUSTED');
  }
  const body=GuardianHubCommandBodySchema.parse(raw);
  return {...body,signature:sign(
    null,guardianHubCommandBytes(body),protectedHubPrivateKey,
  ).toString('base64url')};
}

export interface GuardianHubCommandContext {
  readonly deviceId:string;
  readonly ownerAccountId:string;
  readonly credentialBinding:string;
  /** Guardian-verified latest preference revision, not a request parameter. */
  readonly currentOwnerPreferenceRevision:string;
  /** Local protected Guardian identity, not an HTTP header or body. */
  readonly currentGuardianKeyId:string;
  /** Pin comes from trusted local enrollment, NEVER the incoming envelope. */
  readonly enrolledHubPublicKey:KeyObject;
  readonly now:Date;
  /**
   * Must be durable and transactional across local Guardian restarts.
   * It must atomically reject expired, revoked, re-paired or repeated commands.
   */
  readonly atomicallyReserveRequest:(
    requestId:string,deviceId:string,credentialBinding:string,
    preferenceRevision:string,
  )=>Promise<boolean>;
}

export async function verifyAndReserveGuardianHubCommand(
  raw:unknown,ctx:GuardianHubCommandContext,
):Promise<{readonly authenticated:true;readonly executionAuthorized:false;
  readonly intent:AdminBridgeModeIntent;readonly preferenceRevision:string}> {
  const signed=GuardianHubSignedCommandSchema.parse(raw);
  const intent=validateAdminBridgeModeIntent(signed.intent,{
    deviceId:ctx.deviceId,ownerAccountId:ctx.ownerAccountId,
    credentialBinding:ctx.credentialBinding,now:ctx.now,
    hasConsumedRequestId:()=>false,
  });
  if(signed.ownerPreferenceRevision!==ctx.currentOwnerPreferenceRevision ||
      !revision.safeParse(ctx.currentOwnerPreferenceRevision).success ||
      signed.guardianKeyId!==ctx.currentGuardianKeyId) {
    throw new Error('GUARDIAN_HUB_COMMAND_OWNER_OR_GUARDIAN_REVOKED');
  }
  if(signed.hubSignerKeyId!==hubCommandPublicKeyId(ctx.enrolledHubPublicKey)){
    throw new Error('GUARDIAN_HUB_COMMAND_SIGNER_UNTRUSTED');
  }
  const {signature:encodedSignature,...body}=signed;
  const signatureBytes=Buffer.from(encodedSignature,'base64url');
  if(signatureBytes.length!==64 ||
      signatureBytes.toString('base64url')!==encodedSignature ||
      !verify(null,guardianHubCommandBytes(body),
        ctx.enrolledHubPublicKey,signatureBytes)) {
    throw new Error('GUARDIAN_HUB_COMMAND_SIGNATURE_INVALID');
  }
  const reserved=await ctx.atomicallyReserveRequest(
    intent.requestId,intent.deviceId,intent.credentialBinding,
    signed.ownerPreferenceRevision,
  );
  if(!reserved)throw new Error('GUARDIAN_HUB_COMMAND_REPLAY_OR_REVOKED');

  // A valid Hub command is NOT local elevation or task authorization.
  // Source integrity, expected protected task, owner consent and OS evidence
  // must still be checked by a separate local Guardian actuator.
  return Object.freeze({
    authenticated:true as const,executionAuthorized:false as const,
    intent,preferenceRevision:signed.ownerPreferenceRevision,
  });
}
