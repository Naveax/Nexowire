import path from 'node:path';
import {unsafeWindowsPath} from './scoped-path-grants.js';
import type {NativeHandleEvidence,NativeFileId} from './windows-native-file-source-boundary.js';

/**
 * SOURCE-ONLY contracts. A protected native provider must obtain these from
 * OS-open directory handles, not from remote request JSON or path stat().
 * No Win32 writer, Broker dispatch, UAC, or local ACL mutation is implemented.
 */
export interface NativeRelativeStep {
  /** Independently observed parent handle file ID used for native relative-open. */
  parentFileId:string;
  leaf:string;
  child:NativeHandleEvidence;
}
export interface NativeRelativeChain {
  grantRoot:NativeHandleEvidence;
  steps:readonly NativeRelativeStep[];
  destinationLeaf:string;
}
export interface NativeEffectiveAce {
  sid:string;
  type:'allow'|'deny';
  accessMask:number;
  inheritOnly:boolean;
}
export interface NativeEffectiveAcl {
  provider:'native-verified'|'unavailable';
  observedFileId:string;
  ownerSid:string;
  daclProtected:boolean;
  ancestorsVerified:boolean;
  descendantsVerified:boolean;
  /** Effective and inherited ACEs retrieved from the native SD of the HANDLE. */
  aces:readonly NativeEffectiveAce[];
}
const trusted=new Set(['S-1-5-18','S-1-5-32-544']);
const MAX_PARTS=64;
const WRITE_MASK=(
  0x00000002|0x00000004|0x00000010|0x00000040|0x00000100|
  0x00010000|0x00040000|0x00080000|
  0x40000000|0x10000000|0x02000000
)>>>0;
const ANCESTOR_REPLACE=(0x00000040|0x00010000|0x00040000|0x00080000|
  0x40000000|0x10000000|0x02000000)>>>0;
export class RelativeAccessDenied extends Error {
  constructor(readonly code:string){super(code);this.name='RelativeAccessDenied';}
}
function deny(code:string):never{throw new RelativeAccessDenied(code);}
function canonical(s:string):string{
  if(typeof s!=='string'||!path.win32.isAbsolute(s)||
     unsafeWindowsPath(s)||s.includes('/')||s.startsWith('\\\\')||
     s.split('\\').some(x=>x==='.'||x==='..'||x.endsWith('.')||x.endsWith(' ')||
       x.startsWith(' ')))return deny('NATIVE_RELATIVE_UNSAFE_PATH');
  return path.win32.normalize(s).replace(/\\+$/,'').toLowerCase();
}
function leafName(s:string):string{
  if(typeof s!=='string'||!s||s.length>255||s==='.'||s==='..'||
    s.includes(':')||s.includes('\\')||s.includes('/')||s.endsWith('.')||
    s.endsWith(' ')||s.startsWith(' ')||/[\x00-\x1F]/.test(s)||
    unsafeWindowsPath('C:\\safe\\'+s)){
    return deny('NATIVE_RELATIVE_UNSAFE_LEAF');
  }
  return s;
}
function idSame(a:NativeFileId,b:NativeFileId):boolean{
  if(!a||!b)return false;
  return Boolean(a.fileId&&a.volumeSerial&&a.volumeGuid&&a.diskId&&
    Number.isSafeInteger(a.partitionNumber)&&a.partitionNumber>=0&&
    a.fileId===b.fileId&&a.volumeSerial===b.volumeSerial&&
    a.volumeGuid===b.volumeGuid&&a.diskId===b.diskId&&
    a.partitionNumber===b.partitionNumber);
}
function sameVolume(a:NativeFileId,b:NativeFileId):boolean{
  return Boolean(a && b && a.volumeSerial && a.volumeGuid && a.diskId &&
    Number.isSafeInteger(a.partitionNumber) && a.partitionNumber>=0 &&
    a.volumeSerial===b.volumeSerial && a.volumeGuid===b.volumeGuid &&
    a.diskId===b.diskId && a.partitionNumber===b.partitionNumber);
}
export function assertEffectiveNativeAcl(
  acl:NativeEffectiveAcl,expected:NativeHandleEvidence,
  scope:'protected'|'ancestor'='protected',
):void{
  if(!acl||acl.provider!=='native-verified'||!expected||
    acl.observedFileId!==expected.fileId||
    !trusted.has(acl.ownerSid)||!acl.daclProtected||
    !acl.ancestorsVerified||!acl.descendantsVerified||
    !Array.isArray(acl.aces)){
    deny('NATIVE_EFFECTIVE_ACL_UNVERIFIED');
  }
  const mask=scope==='ancestor'?ANCESTOR_REPLACE:WRITE_MASK;
  for(const ace of acl.aces){
    if(!ace||typeof ace.sid!=='string'||
      (ace.type!=='allow'&&ace.type!=='deny')||
      !Number.isSafeInteger(ace.accessMask)||
      ace.accessMask<0||ace.accessMask>0xffffffff||
      typeof ace.inheritOnly!=='boolean'){
      deny('NATIVE_EFFECTIVE_ACL_UNVERIFIED');
    }
    // A DENY ACE does not cancel a separate ALLOW ACE for an untrusted
    // principal: fail on any unsafe effective grant.
    if(ace.type==='allow'&&!trusted.has(ace.sid)&&
      !(scope==='ancestor'&&ace.inheritOnly)&&
      ((ace.accessMask>>>0)&mask)!==0){
      deny('NATIVE_EFFECTIVE_UNTRUSTED_WRITE');
    }
  }
}
/**
 * Verify every segment from a trusted already-open grant-root directory,
 * using independently witnessed child handles and absolute final kernel
 * paths. The REQUEST PATH DOES NOT CHOOSE the anchor or any traversal.
 */
export function authorizeNativeRelativeChain(
  chain:NativeRelativeChain,
  expectedGrantRoot:string,expectedDestination:string,
):{parent:NativeHandleEvidence;derivedDestination:string}{
  if(!chain||!chain.grantRoot||!Array.isArray(chain.steps)||
     chain.steps.length>MAX_PARTS){
    deny('NATIVE_RELATIVE_CHAIN_UNAVAILABLE');
  }
  const root=canonical(expectedGrantRoot);
  let current=root;
  let previous=chain.grantRoot;
  const check=(handle:NativeHandleEvidence,expected:string)=>{
    if(!handle||handle.objectType!=='directory'||handle.noFollowVerified!==true||
      handle.reparseTag!==null||handle.alternateStream!==false||
      !Number.isSafeInteger(handle.linkCount)||handle.linkCount<1||
      canonical(handle.openedPath)!==canonical(expected)||
      canonical(handle.finalPath)!==canonical(expected)||
      !idSame(handle,handle.observedAfter)){
      deny('NATIVE_RELATIVE_HANDLE_CHANGED');
    }
  };
  check(previous,root);
  for(const step of chain.steps){
    if(!step||step.parentFileId!==previous.fileId){
      deny('NATIVE_RELATIVE_PARENT_ID_MISMATCH');
    }
    const next=path.win32.join(current,leafName(step.leaf));
    if(!sameVolume(previous,step.child)){
      deny('NATIVE_RELATIVE_CROSS_VOLUME');
    }
    check(step.child,next);
    current=next;
    previous=step.child;
  }
  const destination=path.win32.join(current,leafName(chain.destinationLeaf));
  if(canonical(destination)!==canonical(expectedDestination)){
    deny('NATIVE_RELATIVE_REQUEST_PATH_MISMATCH');
  }
  return {parent:previous,derivedDestination:destination};
}
