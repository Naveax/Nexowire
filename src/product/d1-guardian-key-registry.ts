import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { D1DatabaseLike } from './d1-control-plane-store.js';

const SHA256 = /^[a-f0-9]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SPKI = /^[A-Za-z0-9_-]{40,1024}$/;

export interface GuardianSigningKeyIdentity {
  readonly deviceId:string;
  readonly ownerAccountId:string;
  readonly credentialBinding:string;
}
type TrustedGuardianKeyRow = {
  key_id:string;
  device_id:string;
  owner_account_id:string;
  credential_binding:string;
  public_key_spki:string;
  revoked_at:string|null;
};

/**
 * READ ONLY. This adapter is NOT a public enrollment interface.
 * Trust requires a separate privileged owner-approved installer, key custody
 * and D1 write path which do NOT exist here.
 */
export class D1GuardianSigningKeyReadOnlyRegistry {
  constructor(private readonly db: D1DatabaseLike) {}

  async resolveCurrentPairedKey(
    identity:GuardianSigningKeyIdentity,
  ): Promise<KeyObject|null> {
    if (!BOUNDED_ID.test(identity.deviceId) ||
        !BOUNDED_ID.test(identity.ownerAccountId) ||
        !SHA256.test(identity.credentialBinding)) {
      return null;
    }
    // The JOIN rejects stale keys after re-pairing, SAFE or stale presence.
    // LIMIT 2 permits detection of unexpected duplicate active signer rows.
    const result=await this.db.prepare(
      `SELECT k.key_id,k.device_id,k.owner_account_id,
              k.credential_binding,k.public_key_spki,k.revoked_at
       FROM device_guardian_signing_keys AS k
       JOIN devices AS d ON d.id = k.device_id
         AND d.owner_account_id = k.owner_account_id
         AND d.credential_hash = k.credential_binding
         AND d.access_mode = 'full'
         AND d.platform = 'win32'
         AND d.online = 1
         AND d.privilege_mode = 'broker'
         AND d.admin_bridge_ready = 1
       WHERE k.device_id = ?
         AND k.owner_account_id = ?
         AND k.credential_binding = ?
         AND k.revoked_at IS NULL
       LIMIT 2`,
    ).bind(identity.deviceId,identity.ownerAccountId,
      identity.credentialBinding).all<TrustedGuardianKeyRow>();
    if (result.success === false ||
        !Array.isArray(result.results) ||
        result.results.length !== 1) return null;

    const key=result.results[0]!;
    if (key.device_id !== identity.deviceId ||
        key.owner_account_id !== identity.ownerAccountId ||
        key.credential_binding !== identity.credentialBinding ||
        key.revoked_at !== null ||
        !SHA256.test(key.key_id) ||
        !SPKI.test(key.public_key_spki)) return null;
    const der=Buffer.from(key.public_key_spki,'base64url');
    if (der.length<40 || der.length>512 ||
        der.toString('base64url') !== key.public_key_spki) return null;
    try {
      const publicKey=createPublicKey({
        key:der,format:'der',type:'spki',
      });
      const recoded=publicKey.export({format:'der',type:'spki'});
      if (publicKey.type!=='public' ||
          publicKey.asymmetricKeyType!=='ed25519' ||
          !recoded.equals(der) ||
          createHash('sha256').update(der).digest('hex') !== key.key_id) {
        return null;
      }
      return publicKey;
    } catch {
      return null;
    }
  }
}
