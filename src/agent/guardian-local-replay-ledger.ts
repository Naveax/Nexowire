import {createHash} from 'node:crypto';
import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import type {BridgeGuardianAtomicReserve} from './bridge-guardian-policy.js';
import {verifyWindowsPrivateAcl} from '../security/windows-programdata-acl.js';
import {verifyBridgeGuardianSourceAcl} from './bridge-guardian-task-preflight.js';

const STATE_DIRECTORY='C:\\ProgramData\\Nexowire\\bridge-guardian\\state';
const GUARDIAN_ROOT='C:\\ProgramData\\Nexowire\\bridge-guardian';
const REVISION=/^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const DEVICE_ID=/^[A-Za-z0-9._:-]{1,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface GuardianCurrentLocalPairing {
  readonly deviceId:string;
  readonly credentialBinding:string;
  readonly preferenceRevision:string;
  /** Local current pairing and owner approval have NOT been revoked. */
  readonly currentlyAuthorized:boolean;
}

export interface GuardianLocalReplayOptions {
  /** For isolated tests only. Production factory pins the directory. */
  readonly directory:string;
  /** Must reject any unprotected directory or parent/reparse point. */
  readonly assertProtectedDirectory:()=>Promise<void>;
  /** Optional fixture hook; required for production to assert marker ACL. */
  readonly assertProtectedMarker?:(marker:string)=>Promise<void>;
  /** Must independently inspect the current paired device and owner revision. */
  readonly readCurrentPairing:()=>Promise<GuardianCurrentLocalPairing>;
}

/** Stable opaque filename; neither request UUID nor pairing token is a path. */
export function guardianLocalRequestDigest(requestId:string):string {
  if(!UUID.test(requestId))throw new Error('GUARDIAN_REPLAY_REQUEST_INVALID');
  return createHash('sha256').update('nexowire.guardian.local-replay.v1\0')
    .update(requestId).digest('hex');
}

/**
 * Fail-closed tombstone replay ledger. Exclusive creation gives a single
 * local winner across concurrent processes and normal process restarts.
 * An interrupted write retains its tombstone. This does NOT prove durability
 * across abrupt power loss: metadata persistence needs a stronger Windows
 * transactional journal before OS actuation can rely on it.
 *
 * This alone does NOT transact with server-side pairing/revocation, certify
 * the OS task, attest a protected Guardian or authorize execution.
 */
export function createGuardianLocalReplayReserve(
  options:GuardianLocalReplayOptions,
):BridgeGuardianAtomicReserve {
  const {directory,assertProtectedDirectory,assertProtectedMarker,readCurrentPairing}=options;
  if(!path.isAbsolute(directory)||path.normalize(directory)!==directory) {
    throw new Error('GUARDIAN_REPLAY_DIRECTORY_NONCANONICAL');
  }
  return async(requestId,deviceId,credentialBinding,preferenceRevision)=>{
    const key=guardianLocalRequestDigest(requestId);
    if(!DEVICE_ID.test(deviceId)||!DIGEST.test(credentialBinding)||
        !REVISION.test(preferenceRevision)) {
      throw new Error('GUARDIAN_REPLAY_INPUT_INVALID');
    }

    const assertCurrent=async()=>{
      const current=await readCurrentPairing();
      if(!current.currentlyAuthorized ||
          current.deviceId!==deviceId ||
          current.credentialBinding!==credentialBinding ||
          current.preferenceRevision!==preferenceRevision) {
        throw new Error('GUARDIAN_REPLAY_CURRENT_PAIRING_OR_OWNER_REVOKED');
      }
    };
    await assertProtectedDirectory();
    const directoryStat=await lstat(directory);
    if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()){
      throw new Error('GUARDIAN_REPLAY_UNPROTECTED_DIRECTORY');
    }
    await assertCurrent();

    const marker=path.join(directory,key+'.once');
    let handle;
    try {
      handle=await open(marker,'wx',0o600);
    } catch(err) {
      if((err as NodeJS.ErrnoException).code==='EEXIST')return false;
      throw new Error('GUARDIAN_REPLAY_DURABLE_STORAGE_UNAVAILABLE');
    }
    // The tombstone must remain even if subsequent write, sync, ACL or
    // current-pairing revalidation fails: never remove an ambiguous marker.
    try {
      const bytes=Buffer.from(JSON.stringify({
        version:1,requestDigest:key,
        deviceDigest:createHash('sha256').update(deviceId).digest('hex'),
        bindingDigest:createHash('sha256').update(credentialBinding).digest('hex'),
        revisionDigest:createHash('sha256').update(preferenceRevision).digest('hex'),
      })+'\n');
      await handle.writeFile(bytes);
      await handle.sync();
    } catch {
      throw new Error('GUARDIAN_REPLAY_DURABLE_WRITE_UNVERIFIED');
    } finally {
      await handle.close();
    }
    // Re-read after persistence: invalidation here consumes, never applies.
    if(assertProtectedMarker)await assertProtectedMarker(marker);
    await assertProtectedDirectory();
    await assertCurrent();
    return true;
  };
}

/**
 * Production wiring ONLY, no installer. Requires already existing, strongly
 * ACL-protected state root, parent and launcher. No path from HTTP or owner.
 */
export function createProtectedGuardianLocalReplayReserve(
  readCurrentPairing:()=>Promise<GuardianCurrentLocalPairing>,
):BridgeGuardianAtomicReserve {
  if(process.platform!=='win32') {
    throw new Error('GUARDIAN_REPLAY_PROTECTED_WINDOWS_ONLY');
  }
  const root='C:\\ProgramData\\Nexowire';
  const assertProtectedDirectory=async()=>{
    verifyBridgeGuardianSourceAcl();
    for(const node of [root,GUARDIAN_ROOT,STATE_DIRECTORY]) {
      const stat=await lstat(node);
      if(!stat.isDirectory()||stat.isSymbolicLink()){
        throw new Error('GUARDIAN_REPLAY_UNPROTECTED_DIRECTORY');
      }
      verifyWindowsPrivateAcl(node);
    }
  };
  return createGuardianLocalReplayReserve({
    directory:STATE_DIRECTORY,assertProtectedDirectory,readCurrentPairing,
    assertProtectedMarker:async marker=>verifyWindowsPrivateAcl(marker),
  });
}
