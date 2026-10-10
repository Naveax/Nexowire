import {createHash} from 'node:crypto';
import type {D1DatabaseLike} from './d1-control-plane-store.js';
import {
  GuardianKeyEnrollmentProofSchema,
  verifyGuardianKeyEnrollmentProof,
  type GuardianEnrollmentProofContext,
} from '../protocol/guardian-key-enrollment-proof.js';

export type GuardianAtomicEnrollmentContext=Omit<
  GuardianEnrollmentProofContext,'hasConsumedChallenge'
>;

/**
 * A read/write one-time CHALLENGE consume; it never writes the trusted
 * signer registry and cannot grant OS authority or enroll an unknown key.
 * Only a future owner-authorized paired Guardian enrollment flow may call it.
 */
export async function verifyAndConsumeGuardianEnrollmentChallenge(
  db:D1DatabaseLike,rawProof:unknown,ctx:GuardianAtomicEnrollmentContext,
):Promise<{
  readonly possessionVerified:true;
  readonly challengeConsumed:true;
  readonly enrollmentAuthorized:false;
  readonly requestId:string;
  readonly publicKeyFingerprint:string;
}> {
  const proof=GuardianKeyEnrollmentProofSchema.parse(rawProof);
  const validated=verifyGuardianKeyEnrollmentProof(proof,{
    ...ctx,
    // Transactional replay rejection occurs in the UPDATE statement.
    hasConsumedChallenge:()=>false,
  });
  const nonceBytes=Buffer.from(proof.challenge.nonce,'base64url');
  const nonceHash=createHash('sha256').update(nonceBytes).digest('hex');
  const now=ctx.now.toISOString();
  const result=await db.prepare(
    `UPDATE device_guardian_enrollment_challenges
       SET consumed_at = ?
     WHERE request_id = ?
       AND device_id = ?
       AND owner_account_id = ?
       AND credential_binding = ?
       AND nonce_hash = ?
       AND purpose = 'bridge-mode-receipts'
       AND issued_at = ?
       AND expires_at = ?
       AND consumed_at IS NULL
       AND issued_at <= ?
       AND expires_at > ?
       -- An old application timestamp is insufficient when D1 was queued:
       -- evaluate UTC time when SQLite actually executes this UPDATE.
       AND issued_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND EXISTS (
         SELECT 1 FROM devices AS d
         WHERE d.id = device_guardian_enrollment_challenges.device_id
           AND d.owner_account_id = device_guardian_enrollment_challenges.owner_account_id
           AND d.credential_hash = device_guardian_enrollment_challenges.credential_binding
           AND d.platform = 'win32'
           AND d.access_mode = 'full'
           AND d.online = 1
           AND d.privilege_mode = 'broker'
           AND d.admin_bridge_ready = 1
       )`,
  ).bind(now,proof.challenge.requestId,proof.challenge.deviceId,
    proof.challenge.ownerAccountId,proof.challenge.credentialBinding,
    nonceHash,proof.challenge.issuedAt,proof.challenge.expiresAt,
    now,now).run();
  if (result.success===false || result.meta?.changes!==1) {
    throw new Error('GUARDIAN_ENROLLMENT_CHALLENGE_EXPIRED_CONSUMED_OR_REPAIRED');
  }
  return Object.freeze({
    possessionVerified:validated.possessionVerified,
    challengeConsumed:true as const,
    enrollmentAuthorized:false as const,
    requestId:validated.requestId,
    publicKeyFingerprint:validated.publicKeyFingerprint,
  });
}
