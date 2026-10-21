import path from 'node:path';
import { unsafeWindowsPath } from './scoped-path-grants.js';
import {
  assertNativeProtectedFileBoundary,
  NativeFileBoundaryError,
  type VerifiedFilesystemBoundary,
} from './windows-native-file-source-boundary.js';

/**
 * SOURCE-ONLY acceptance model for a potential future CORE elevated file
 * Broker. No production Broker file capability is registered or dispatched.
 *
 * All facts must be read by a trusted high-integrity native Broker from the
 * OS or protected enrollment storage, never decoded from remote MCP JSON.
 * ACL attestation and signer verification are independent checks: a pathname
 * or boolean supplied by the caller is not evidence.
 */
export interface BrokerFilesystemIdentity {
  sid: string;
  ownerId: string;
  deviceId: string;
  integrity: 'low' | 'medium' | 'high' | 'system' | 'unknown';
  authenticated: boolean;
}
export interface BrokerFilesystemIntent {
  readonly source: string;
  readonly destination: string;
  readonly scope: 'read' | 'write' | 'delete' | 'move';
}
export interface BrokerFilesystemTrust {
  /**
   * Witnesses must be independently produced by an OS-native, protected
   * observer from installed manifest, owner epoch and actual open handles.
   * Do not pass requested path to the provider to choose the source.
   * No production adapter currently exists: unavailable => fail closed.
   */
  inspectNativeFilesystemBoundary(): Promise<VerifiedFilesystemBoundary | null>;
  /** Read-only verified OS token observation, not a caller-supplied flag. */
  brokerToken(): Promise<BrokerFilesystemIdentity | null>;
  /** Paired caller identity bound to the trusted broker IPC peer. */
  callerToken(): Promise<BrokerFilesystemIdentity | null>;
  /** Canonical owner/device binding read from protected enrollment. */
  destinationOwner(): Promise<{ownerId:string;deviceId:string} | null>;
  /**
   * Read-only physical handle identity + trusted publisher/ACL proof for
   * the source and all ancestors; no following an untrusted junction.
   */
  attestProtectedSource(source:string): Promise<boolean>;
  /**
   * Scoped destination grant lookup bound to owner/device and verified
   * volume identity. Must fail closed after hotplug or revoke.
   */
  authorizeDestination(destination:string,scope:BrokerFilesystemIntent['scope'],
    ownerId:string,deviceId:string):Promise<boolean>;
}
export class BrokerFilesystemPreflightError extends Error {
  constructor(public readonly code:string) {
    super(code);
    this.name='BrokerFilesystemPreflightError';
  }
}
function deny(code:string):never { throw new BrokerFilesystemPreflightError(code); }
function fixedProtectedPath(source:string):boolean {
  if(!path.win32.isAbsolute(source) || unsafeWindowsPath(source) ||
      source.includes('/') || source.includes('..') ||
      source.startsWith('\\\\'))return false;
  const normalized=path.win32.normalize(source).toLowerCase();
  const protectedRoots=[
    'c:\\programdata\\nexowire\\privileged-broker',
    'c:\\program files\\nexowire',
  ];
  return protectedRoots.some(root=>normalized.startsWith(root+'\\'));
}
const same=(x:string,y:string)=>x===y&&x.trim()!=='';
/**
 * Pure policy preflight only. Passing this function does NOT delegate,
 * authorize any real mutation, attest an actual Windows token, or start
 * an elevated helper. Never wire it to a production operation until
 * #271 protected runtime ACL and #551 signed installer/rollback pass.
 */
export async function assertCoreBrokerFilesystemPreflight(
  intent:BrokerFilesystemIntent,
  trust:BrokerFilesystemTrust,
):Promise<{validated:true;ownerId:string;deviceId:string}>{
  if(!intent || !['read','write','delete','move'].includes(intent.scope) ||
      typeof intent.source!=='string' || typeof intent.destination!=='string'){
    return deny('BROKER_FILE_INVALID_INTENT');
  }
  if(!fixedProtectedPath(intent.source)){
    return deny('BROKER_FILE_SOURCE_NOT_PROTECTED');
  }
  const [broker,caller,owner]=await Promise.all([
    trust.brokerToken(),trust.callerToken(),trust.destinationOwner(),
  ]);
  if(!broker?.authenticated ||
     !['high','system'].includes(broker.integrity) ||
     !/^S-1-5-/.test(broker.sid)){
    return deny('BROKER_FILE_HIGH_TOKEN_NOT_VERIFIED');
  }
  // A lower-integrity caller may request ordinary Agent file operations, but
  // is not a trusted source for a HIGH-integrity Broker file mutation.
  if(!caller?.authenticated ||
     !['high','system'].includes(caller.integrity) ||
     !/^S-1-5-/.test(caller.sid)){
    return deny('BROKER_FILE_MEDIUM_CALLER_DENIED');
  }
  if(!owner || !same(broker.ownerId,caller.ownerId) ||
     !same(caller.ownerId,owner.ownerId) ||
     !same(broker.deviceId,caller.deviceId) ||
     !same(caller.deviceId,owner.deviceId)){
    return deny('BROKER_FILE_OWNER_DEVICE_MISMATCH');
  }
  // Never treat an unprotected path or a caller-declared signed flag as
  // evidence. An actual privileged witness must inspect effective ACL,
  // protected parent/updater, publisher, file IDs, and no-follow handles.
  if(!(await trust.attestProtectedSource(intent.source))){
    return deny('BROKER_FILE_SOURCE_ATTESTATION_FAILED');
  }
  if(!(await trust.authorizeDestination(
    intent.destination,intent.scope,owner.ownerId,owner.deviceId))){
    return deny('BROKER_FILE_DESTINATION_GRANT_DENIED');
  }
  const native = await trust.inspectNativeFilesystemBoundary();
  if(!native)return deny('BROKER_FILE_NATIVE_WITNESS_UNAVAILABLE');
  try {
    assertNativeProtectedFileBoundary(intent.source,intent.destination,
      intent.scope,owner.ownerId,owner.deviceId,native);
  }catch(error){
    if(error instanceof NativeFileBoundaryError){
      return deny(error.code);
    }
    throw error;
  }
  return {validated:true,ownerId:owner.ownerId,deviceId:owner.deviceId};
}
