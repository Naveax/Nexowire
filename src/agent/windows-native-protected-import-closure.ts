import path from 'node:path';
import {unsafeWindowsPath} from './scoped-path-grants.js';
import {
  assertEffectiveNativeAcl,
  authorizeNativeRelativeChain,
  type NativeEffectiveAcl,
  type NativeRelativeChain,
} from './windows-native-relative-access.js';
import type {
  NativeHandleEvidence,NativeFileId,ProtectedAclEvidence,ProtectedRole,
} from './windows-native-file-source-boundary.js';

/**
 * Source-only import closure gate, NOT a native Win32 provider or executable
 * loader. A protected OS helper must gather both independently authenticated
 * installed-manifest pins and OS-open file/ACL/image evidence.
 * Remote JSON and pathname stat() may NEVER instantiate this authority.
 */
export interface PinnedImport {
  key:string;
  path:string;
  role:ProtectedRole;
  sha256:string;
  signerCertificateSha256:string;
  imports:readonly string[];
}
export interface VerifiedImportOpen {
  provider:'native-retained-handle'|'unavailable';
  api:'NtCreateFile.RootDirectory'|'OpenFileById';
  parentFileId:string;
  openedFileId:string;
  /** Observe again on the same retained handle after signed-byte readback. */
  afterReadback:NativeFileId;
  /** Fresh SHA-256 over bytes reread through the same retained image handle. */
  digestAfterReadbackSha256:string;
  /** Authenticode/cert witness explicitly bound to those retained bytes. */
  signerDigestAfterReadbackSha256:string;
  signerBinding:'same-retained-image'|'unavailable';
  noReparseTraversal:boolean;
  retainedUntilVerified:boolean;
}
export interface ObservedImport {
  key:string;
  handle:NativeHandleEvidence;
  parentRelativeChain:NativeRelativeChain;
  /** Every directory below the protected anchor needs its OWN effective ACL. */
  intermediateDirectoryAcls:readonly NativeEffectiveAcl[];
  open:VerifiedImportOpen;
  effectiveAcl:NativeEffectiveAcl;
  sha256:string;
  signerCertificateSha256:string;
  authenticodeStatus:'Valid'|'Invalid'|'Unavailable';
  /** Complete provider-side PE imports + delay imports + load policy. */
  importInventoryComplete:boolean;
  discoveredImports:readonly string[];
}
export interface ProtectedImportGraph {
  /** Exact numeric schema version; JSON '1' and true are not valid v1. */
  schemaVersion:1;
  manifestProvider:'protected-installed-manifest'|'unavailable';
  /** OS provider proved manifest bytes bound to installed signed release. */
  manifestSignatureVerified:boolean;
  rootKey:string;
  pinned:readonly PinnedImport[];
  observed:readonly ObservedImport[];
}
export class ProtectedImportError extends Error {
  constructor(readonly code:string){super(code);this.name='ProtectedImportError';}
}
function deny(code:string):never {throw new ProtectedImportError(code);}
const ROOTS={
  parent:'C:\\ProgramData\\Nexowire',
  updater:'C:\\ProgramData\\Nexowire\\updater',
  module:'C:\\Program Files\\Nexowire\\modules',
} as const;
const sha=/^[0-9a-f]{64}$/i;
function clean(p:string):string {
  if(typeof p!=='string'||p.length>4096||!path.win32.isAbsolute(p)||
     unsafeWindowsPath(p)||p.includes('/')||p.startsWith('\\\\')||
     p.split('\\').some(s=>!s||s==='.'||s==='..'||s.endsWith('.')||
       s.endsWith(' ')||s.startsWith(' ')))deny('IMPORT_UNSAFE_PATH');
  return path.win32.normalize(p).toLowerCase();
}
function isWithin(root:string,child:string):boolean{
  const r=clean(root),c=clean(child);
  return c.startsWith(r+'\\');
}
function sameNativeId(a:NativeFileId,b:NativeFileId):boolean {
  return Boolean(a&&b&&a.fileId&&a.volumeSerial&&a.volumeGuid&&a.diskId&&
    Number.isSafeInteger(a.partitionNumber)&&a.partitionNumber>=0&&
    a.fileId===b.fileId&&a.volumeSerial===b.volumeSerial&&
    a.volumeGuid===b.volumeGuid&&a.diskId===b.diskId&&
    a.partitionNumber===b.partitionNumber);
}
function sameVolume(a:NativeFileId,b:NativeFileId):boolean {
  return Boolean(a&&b&&a.volumeSerial&&a.volumeGuid&&a.diskId&&
    Number.isSafeInteger(a.partitionNumber)&&a.partitionNumber>=0&&
    a.volumeSerial===b.volumeSerial&&a.volumeGuid===b.volumeGuid&&
    a.diskId===b.diskId&&a.partitionNumber===b.partitionNumber);
}
function refsEqual(a:readonly string[],b:readonly string[]):boolean {
  if(a.length!==b.length)return false;
  const sa=[...a].sort(),sb=[...b].sort();
  return sa.every((x,i)=>x===sb[i]);
}
/**
 * Verify that *every* imported DLL is in a signed, immutable, provider-
 * enumerated closure. Unknown, omitted, injected, aliased or replaced imports
 * are rejected instead of covered by a role-wide signed=true flag.
 *
 * This function does NOT hold OS handles itself. With no trusted Win32
 * producer wired to CORE, it cannot authorize any production execution.
 */
export function assertProtectedImportClosure(
  graph:ProtectedImportGraph,
  pinnedSource:string,source:NativeHandleEvidence,
  protectedRoots:Readonly<Record<ProtectedRole,ProtectedAclEvidence>>,
):{importsVerified:number;verifiedFileIds:readonly string[]}{
  if(!graph||graph.schemaVersion!==1||
     graph.manifestProvider!=='protected-installed-manifest'||
     graph.manifestSignatureVerified!==true||
     !Array.isArray(graph.pinned)||!Array.isArray(graph.observed)||
     !graph.rootKey||graph.pinned.length<1||graph.pinned.length>128||
     graph.observed.length!==graph.pinned.length){
    deny('IMPORT_MANIFEST_OR_INVENTORY_UNAVAILABLE');
  }
  const expected=new Map<string,PinnedImport>();
  const actual=new Map<string,ObservedImport>();
  const physicalPaths=new Set<string>();
  for(const pin of graph.pinned){
    if(!pin||typeof pin.key!=='string'||! /^[A-Za-z0-9_.-]{1,128}$/.test(pin.key)||
       expected.has(pin.key)||!Object.hasOwn(ROOTS,pin.role)||
       !sha.test(pin.sha256)||!sha.test(pin.signerCertificateSha256)||
       !Array.isArray(pin.imports)||pin.imports.length>128||
       new Set(pin.imports).size!==pin.imports.length||
       !pin.imports.every((k:string)=>typeof k==='string'&&k.length>0)){
      deny('IMPORT_INVALID_PIN_OR_DUPLICATE');
    }
    const diskPath=clean(pin.path);
    if(!isWithin(ROOTS[pin.role as ProtectedRole],diskPath)||physicalPaths.has(diskPath)){
      deny('IMPORT_UNPROTECTED_OR_ALIASED_PATH');
    }
    physicalPaths.add(diskPath);
    expected.set(pin.key,pin);
  }
  for(const item of graph.observed){
    if(!item||typeof item.key!=='string'||actual.has(item.key)||
       !expected.has(item.key)){
      deny('IMPORT_UNEXPECTED_OR_DUPLICATE_BINARY');
    }
    actual.set(item.key,item);
  }
  if(!expected.has(graph.rootKey)||
     clean(expected.get(graph.rootKey)!.path)!==clean(pinnedSource)||
     expected.get(graph.rootKey)!.role!=='parent'){
    deny('IMPORT_ROOT_NOT_PINNED');
  }
  // Fail closed for missing transitive imports, orphan inventory entries,
  // non-DAG imports or provider-discovered edges absent from the manifest.
  const reached=new Set<string>();
  const active=new Set<string>();
  let edges=0;
  const visit=(key:string,depth:number):void=>{
    if(depth>64||active.has(key))deny('IMPORT_GRAPH_CYCLE_OR_DEPTH');
    if(reached.has(key))return;
    const pin=expected.get(key);
    if(!pin)deny('IMPORT_UNPINNED_TRANSITIVE_MODULE');
    active.add(key);
    for(const child of pin.imports){
      edges++;
      if(edges>512)deny('IMPORT_GRAPH_TOO_LARGE');
      visit(child,depth+1);
    }
    active.delete(key);
    reached.add(key);
  };
  visit(graph.rootKey,0);
  if(reached.size!==expected.size)deny('IMPORT_ORPHANED_OR_UNREACHABLE_MODULE');
  const usedFileIds=new Set<string>();
  for(const [key,pin] of expected){
    const observed=actual.get(key);
    if(!observed||observed.importInventoryComplete!==true||
       !Array.isArray(observed.discoveredImports)||
       !refsEqual(pin.imports,observed.discoveredImports)){
      deny('IMPORT_DISCOVERED_GRAPH_MISMATCH');
    }
    if(observed.authenticodeStatus!=='Valid'||
       observed.sha256.toLowerCase()!==pin.sha256.toLowerCase()||
       observed.signerCertificateSha256.toLowerCase()!==
         pin.signerCertificateSha256.toLowerCase()){
      deny('IMPORT_SIGNER_OR_DIGEST_MISMATCH');
    }
    const anchor=protectedRoots?.[pin.role];
    if(!anchor||!anchor.handle||!observed.parentRelativeChain||
       !sameNativeId(anchor.handle,observed.parentRelativeChain.grantRoot)){
      deny('IMPORT_PROTECTED_ANCHOR_MISMATCH');
    }
    // Do not use a string-selected absolute OpenFile path: only a verified
    // native RootDirectory/OpenFileById witness rooted at a pinned handle.
    const relative=authorizeNativeRelativeChain(
      observed.parentRelativeChain,ROOTS[pin.role],pin.path);
    // #709's caller-supplied import path/boolean audit cannot stand in for
    // protected native handle-bound ACL evidence. The signed manifest anchor
    // and EVERY intermediate directory must independently pass effective ACE
    // checks, including inherited future writes and delete-child rights.
    assertEffectiveNativeAcl(anchor.effectiveAcl,anchor.handle);
    const steps=observed.parentRelativeChain.steps;
    if(!Array.isArray(steps)||steps.some(step=>
       !step||step.child?.noFollowVerified!==true||
       step.child?.alternateStream!==false)){
      deny('IMPORT_ANCESTOR_HANDLE_FLAGS_UNVERIFIED');
    }
    if(observed.parentRelativeChain.grantRoot.noFollowVerified!==true||
       observed.parentRelativeChain.grantRoot.alternateStream!==false){
      deny('IMPORT_ANCESTOR_HANDLE_FLAGS_UNVERIFIED');
    }
    if(!Array.isArray(observed.intermediateDirectoryAcls)||
       observed.intermediateDirectoryAcls.length!==steps.length){
      deny('IMPORT_ANCESTOR_ACL_INCOMPLETE');
    }
    for(let index=0;index<steps.length;index++){
      assertEffectiveNativeAcl(observed.intermediateDirectoryAcls[index]!,
        steps[index]!.child);
    }
    const handle=observed.handle;
    if(!handle||handle.objectType!=='file'||handle.noFollowVerified!==true||
       handle.reparseTag!==null||handle.alternateStream!==false||
       handle.linkCount!==1||
       clean(handle.openedPath)!==clean(pin.path)||
       clean(handle.finalPath)!==clean(pin.path)||
       !sameNativeId(handle,handle.observedAfter)||
       !sameVolume(anchor.handle,handle)){
      deny('IMPORT_FILE_HANDLE_UNVERIFIED');
    }
    const nativeOpen=observed.open;
    if(!nativeOpen||nativeOpen.provider!=='native-retained-handle'||
       !['NtCreateFile.RootDirectory','OpenFileById'].includes(nativeOpen.api)||
       nativeOpen.noReparseTraversal!==true||
       nativeOpen.retainedUntilVerified!==true||
       nativeOpen.parentFileId!==relative.parent.fileId||
       nativeOpen.openedFileId!==handle.fileId||
       !sameNativeId(handle,nativeOpen.afterReadback)){
      deny('IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
    }
    // The unchanged file ID does NOT prove unchanged bytes: updates through
    // the retained handle can change content without changing its identity.
    // Both digest and Authenticode certificate proof must still bind to the
    // exact retained image AFTER readback, independently from pathname data.
    if(nativeOpen.signerBinding!=='same-retained-image'||
       nativeOpen.digestAfterReadbackSha256?.toLowerCase()!==
         pin.sha256.toLowerCase()||
       nativeOpen.signerDigestAfterReadbackSha256?.toLowerCase()!==
         pin.signerCertificateSha256.toLowerCase()){
      deny('IMPORT_POST_READBACK_SIGNER_OR_BYTES_CHANGED');
    }
    // Checks *each* imported image's effective ACL rather than only the
    // role-wide root. Missing or medium-writable DLL rejects the full chain.
    assertEffectiveNativeAcl(observed.effectiveAcl,handle);
    const objectIdentity=[
      handle.volumeGuid.toLowerCase(),handle.volumeSerial.toLowerCase(),
      handle.diskId.toLowerCase(),String(handle.partitionNumber),handle.fileId,
    ].join(':');
    if(usedFileIds.has(objectIdentity))deny('IMPORT_HARDLINK_OR_ALIAS_COLLISION');
    usedFileIds.add(objectIdentity);
    if(key===graph.rootKey&&!sameNativeId(source,handle)){
      deny('IMPORT_SOURCE_HANDLE_NOT_PINNED');
    }
  }
  return {importsVerified:expected.size,
    verifiedFileIds:[...expected.keys()].map(k=>actual.get(k)!.handle.fileId)};
}
