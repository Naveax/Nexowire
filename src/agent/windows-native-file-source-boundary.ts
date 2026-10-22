import path from 'node:path';
import {unsafeWindowsPath} from './scoped-path-grants.js';
import {
  assertProtectedImportClosure,
  type ProtectedImportGraph,
} from './windows-native-protected-import-closure.js';
import {
  assertEffectiveNativeAcl,
  authorizeNativeRelativeChain,
  RelativeAccessDenied,
  type NativeEffectiveAcl,
  type NativeRelativeChain,
} from './windows-native-relative-access.js';

/**
 * #05 SOURCE CONTRACT ONLY. Inputs must be produced by a trusted, protected
 * OS handle/ACL/owner-grant witness, not derived from MCP request payloads.
 * This is NOT an implementation of handle-relative Win32 file mutation.
 */
export const PINNED_FILE_PROTECTED_COMPONENTS = Object.freeze({
  parent:'C:\\ProgramData\\Nexowire',
  updater:'C:\\ProgramData\\Nexowire\\updater',
  module:'C:\\Program Files\\Nexowire\\modules',
} as const);
export type ProtectedRole = keyof typeof PINNED_FILE_PROTECTED_COMPONENTS;
export type FileScope = 'read'|'write'|'delete'|'move';
export interface NativeFileId {
  /** GetFileInformationByHandle / FileIdInfo, not pathname-derived. */
  fileId:string;
  volumeSerial:string;
  volumeGuid:string;
  diskId:string;
  partitionNumber:number;
}
export interface NativeHandleEvidence extends NativeFileId {
  openedPath:string;
  finalPath:string;
  objectType:'file'|'directory';
  reparseTag:number|null;
  alternateStream:boolean;
  linkCount:number;
  /** Both observations must be independently sampled from the SAME open OS handle. */
  observedAfter:NativeFileId;
  /** Physical no-follow CreateFileW/FILE_FLAG_OPEN_REPARSE_POINT evidence. */
  noFollowVerified:boolean;
}
export interface ProtectedAclEvidence {
  role:ProtectedRole;
  /** Handle identity for protected component and its final physical location. */
  handle:NativeHandleEvidence;
  aclOwnerSid:string;
  daclProtected:boolean;
  untrustedWriteOrDeleteOrOwnerRights:boolean;
  ancestorChainChecked:boolean;
  descendantsChecked:boolean;
  provider:'native-verified'|'unavailable';
  /** For module import tree and updater binaries; signed provenance is independent of ACL. */
  pinnedPublisherAndDigest:boolean;
  /** OS handle security descriptor ACEs checked independently of booleans. */
  effectiveAcl:NativeEffectiveAcl;
}
export interface NativeGrantEvidence {
  ownerId:string;
  deviceId:string;
  scopes:readonly FileScope[];
  root:string;
  expiresAtMonotonic:number;
  observedAtMonotonic:number;
  approvalEpoch:number;
  currentOwnerEpoch:number;
  volumeGuid:string;
  diskId:string;
  partitionNumber:number;
  /** For removable volumes, the explicit short-lived grant must also cover USB write. */
  removable:boolean;
  usbWriteApproved:boolean;
  ownerApprovalVerified:boolean;
}
export interface VerifiedFilesystemBoundary {
  /** Trusted install manifest/owner enrollment, not a caller-supplied root. */
  pinnedSource:string;
  source:NativeHandleEvidence;
  /** ACL and exact installed signer/digest of the source object itself. */
  sourceAclOwnerSid:string;
  sourceDaclProtected:boolean;
  sourceUntrustedWriteOrDeleteOrOwnerRights:boolean;
  sourcePublisherAndDigestVerified:boolean;
  sourceEffectiveAcl:NativeEffectiveAcl;
  /** Verified native directory-handle relative traversal, never from request input. */
  destinationRelativeChain:NativeRelativeChain;
  destinationParent:NativeHandleEvidence;
  protectedComponents:Readonly<Record<ProtectedRole,ProtectedAclEvidence>>;
  /** Mandatory independently pinned transitive DLL/PE imports closure. */
  protectedImportGraph:ProtectedImportGraph;
  grant:NativeGrantEvidence;
}
export class NativeFileBoundaryError extends Error {
  constructor(readonly code:string){super(code);this.name='NativeFileBoundaryError';}
}
function deny(code:string):never{throw new NativeFileBoundaryError(code);}
function canonical(p:string):string{
  if(typeof p!=='string'||p.length===0||p.length>4096||
    !path.win32.isAbsolute(p)||unsafeWindowsPath(p)||
    p.includes('/')||p.startsWith('\\\\')||
    p.split('\\').some(s=>s==='.'||s==='..'||s.trim()!==s||s.endsWith('.'))){
    return deny('FILE_NATIVE_UNSAFE_PATH');
  }
  return path.win32.normalize(p).toLowerCase().replace(/\\+$/,'');
}
function inside(root:string,child:string):boolean {
  const a=canonical(root),b=canonical(child);
  return b===a||b.startsWith(a+'\\');
}
function idMatches(a:NativeFileId,b:NativeFileId):boolean{
  if(!a || !b || typeof a!=='object' || typeof b!=='object')return false;
  return Boolean(a.fileId && a.volumeSerial && a.volumeGuid && a.diskId &&
    Number.isSafeInteger(a.partitionNumber) && a.partitionNumber>=0 &&
    a.fileId===b.fileId && a.volumeSerial===b.volumeSerial &&
    a.volumeGuid===b.volumeGuid && a.diskId===b.diskId &&
    a.partitionNumber===b.partitionNumber);
}
export function assertNativeHandleIdentity(
  handle:NativeHandleEvidence,expected:string,kind:'file'|'directory',
):void{
  if(!handle||!handle.noFollowVerified || handle.objectType!==kind ||
     handle.alternateStream || handle.reparseTag!==null ||
     !Number.isSafeInteger(handle.linkCount)||handle.linkCount<1 ||
     (kind==='file' && handle.linkCount!==1) ||
     canonical(handle.openedPath)!==canonical(expected) ||
     canonical(handle.finalPath)!==canonical(expected) ||
     !idMatches(handle,handle.observedAfter)) {
    deny('FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED');
  }
}
const trustedOwners=new Set([
  'S-1-5-18', // SYSTEM
  'S-1-5-32-544', // BUILTIN\Administrators
]);
function assertProtected(acl:ProtectedAclEvidence,role:ProtectedRole):void{
  const expected=PINNED_FILE_PROTECTED_COMPONENTS[role];
  if(!acl||acl.role!==role ||acl.provider!=='native-verified'||
      !trustedOwners.has(acl.aclOwnerSid)||
      !acl.daclProtected || acl.untrustedWriteOrDeleteOrOwnerRights ||
      !acl.ancestorChainChecked || !acl.descendantsChecked ||
      !acl.pinnedPublisherAndDigest){
    deny('FILE_NATIVE_PROTECTED_ACL_UNVERIFIED');
  }
  assertNativeHandleIdentity(acl.handle,expected,'directory');
  assertEffectiveNativeAcl(acl.effectiveAcl,acl.handle);
}
export function assertNativeProtectedFileBoundary(
  requestedSource:string,requestedDestination:string,
  scope:FileScope, ownerId:string,deviceId:string,
  evidence:VerifiedFilesystemBoundary,
):{sourceFileId:string;parentFileId:string;volumeGuid:string}{
  // The source path is independently pinned in the trusted installed manifest;
  // it is never selected by elevated request JSON.
  if(!evidence||!['read','write','delete','move'].includes(scope)||
     !ownerId || !deviceId ||
     !inside('C:\\Program Files\\Nexowire',evidence.pinnedSource)&&
     !inside('C:\\ProgramData\\Nexowire\\privileged-broker',evidence.pinnedSource)){
    deny('FILE_NATIVE_UNTRUSTED_PINNED_SOURCE');
  }
  if(canonical(requestedSource)!==canonical(evidence.pinnedSource)){
    deny('FILE_NATIVE_CALLER_SOURCE_MISMATCH');
  }
  assertNativeHandleIdentity(evidence.source,evidence.pinnedSource,'file');
  if(!trustedOwners.has(evidence.sourceAclOwnerSid) ||
     !evidence.sourceDaclProtected ||
     evidence.sourceUntrustedWriteOrDeleteOrOwnerRights ||
     !evidence.sourcePublisherAndDigestVerified){
    deny('FILE_NATIVE_SOURCE_ACL_OR_SIGNER_UNVERIFIED');
  }
  assertEffectiveNativeAcl(evidence.sourceEffectiveAcl,evidence.source);
  for(const role of ['parent','updater','module'] as const){
    assertProtected(evidence.protectedComponents?.[role],role);
  }
  // Role-wide signed/ACL flags do not prove each imported updater DLL.
  // Require independently inventoried and signed *transitive* import closure.
  assertProtectedImportClosure(evidence.protectedImportGraph,
    evidence.pinnedSource,evidence.source,evidence.protectedComponents);
  const grant=evidence.grant;
  if(!grant)deny('FILE_NATIVE_OWNER_VOLUME_GRANT_UNVERIFIED');
  // Every segment is derived from the independently pinned grant root handle.
  // The caller path can only MATCH the derived destination; it never selects it.
  let verified:ReturnType<typeof authorizeNativeRelativeChain>;
  try {
    verified=authorizeNativeRelativeChain(
      evidence.destinationRelativeChain,grant.root,requestedDestination);
  }catch(error){
    if(error instanceof RelativeAccessDenied){
      deny(error.code==='NATIVE_RELATIVE_REQUEST_PATH_MISMATCH' ||
        error.code==='NATIVE_RELATIVE_UNSAFE_PATH' ||
        error.code==='NATIVE_RELATIVE_UNSAFE_LEAF'
        ? 'FILE_NATIVE_OWNER_VOLUME_GRANT_UNVERIFIED'
        : 'FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED');
    }
    throw error;
  }
  const parentPath=path.win32.dirname(canonical(verified.derivedDestination));
  assertNativeHandleIdentity(evidence.destinationParent,parentPath,'directory');
  // File IDs are volume-scoped; two independently retained handles must
  // agree on the FULL native identity, including volume serial/partition.
  if(!idMatches(verified.parent,evidence.destinationParent)){
    deny('FILE_NATIVE_PARENT_HANDLE_NOT_PINNED');
  }
  if(!grant.ownerApprovalVerified ||
     grant.ownerId!==ownerId||grant.deviceId!==deviceId||
     !grant.scopes.includes(scope) ||
     !Number.isFinite(grant.expiresAtMonotonic) ||
     !Number.isFinite(grant.observedAtMonotonic)||
     grant.expiresAtMonotonic<=grant.observedAtMonotonic ||
     !Number.isSafeInteger(grant.approvalEpoch) ||
     grant.approvalEpoch!==grant.currentOwnerEpoch ||
     !inside(grant.root,requestedDestination) ||
     !idMatches(evidence.destinationParent,evidence.destinationParent.observedAfter) ||
     evidence.destinationParent.volumeGuid!==grant.volumeGuid ||
     evidence.destinationParent.diskId!==grant.diskId ||
     evidence.destinationParent.partitionNumber!==grant.partitionNumber ||
     (grant.removable && scope!=='read' && !grant.usbWriteApproved)){
    deny('FILE_NATIVE_OWNER_VOLUME_GRANT_UNVERIFIED');
  }
  return {
    sourceFileId:evidence.source.fileId,
    parentFileId:evidence.destinationParent.fileId,
    volumeGuid:evidence.destinationParent.volumeGuid,
  };
}
