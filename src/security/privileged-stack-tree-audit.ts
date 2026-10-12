import {lstatSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {auditPrivilegedStackSource} from './privileged-stack-source-audit.js';
import {verifyWindowsPrivateAcl,verifyWindowsStackOuterAncestorAcl} from './windows-programdata-acl.js';

const PRODUCTION_STACK_ROOT='C:\\ProgramData\\NexowireStack';
const MAX_ENTRIES=150000;
const MAX_DEPTH=48;
const MAX_PATH_LENGTH=4096;

// File identity and modification metadata observed before an ACL check.
// Ignore atime (read-only traversal can update it). This is a race detector,
// not a substitute for a kernel-held handle or runtime code attestation.
function sourceFingerprint(
  node:string,stat:NonNullable<ReturnType<typeof lstatSync>>,
):string {
  return JSON.stringify([
    stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,
    stat.mtimeMs,stat.ctimeMs,stat.birthtimeMs,
    stat.isFile(),stat.isDirectory(),stat.isSymbolicLink(),
    // NTFS directory metadata alone may not reflect children added/removed.
    // Snapshot the actual names to reject those changes on revalidation.
    stat.isDirectory()?readdirSync(node).sort():null,
  ]);
}

function assertSourceUnchanged(node:string,fingerprint:string):void {
  let current:NonNullable<ReturnType<typeof lstatSync>>;
  try {
    current=lstatSync(node);
  } catch {
    throw new Error('STACK_TREE_CHANGED_DURING_AUDIT');
  }
  let latest:string;
  try {
    latest=sourceFingerprint(node,current);
  } catch {
    throw new Error('STACK_TREE_CHANGED_DURING_AUDIT');
  }
  if(latest!==fingerprint) {
    throw new Error('STACK_TREE_CHANGED_DURING_AUDIT');
  }
}

export interface ReadOnlySourceTreeInventory {
  readonly scannedFiles:number;
  readonly scannedDirectories:number;
  readonly verifiedAclEntries:number;
  readonly symlinksFollowed:false;
  readonly modificationsPerformed:false;
  /** Inventory completeness is not runtime signature/publisher attestation. */
  readonly runtimeAttested:false;
}

/**
 * A limited read-only filesystem+ACL walker. This exported pure mechanism is
 * NOT trusted attestation: the caller supplies an ACL checker. Only the pinned
 * production wrapper below uses the real Windows private-ACL verifier.
 */
export function inventoryReadOnlySourceTree(
  root:string,
  aclCheck:(absolutePath:string)=>void,
  limits:{readonly maxEntries?:number;readonly maxDepth?:number}={},
):ReadOnlySourceTreeInventory {
  if(!path.isAbsolute(root) ||
      path.normalize(root)!==root ||
      root.includes('..'+path.sep) ||
      root.includes(path.sep+'.'+path.sep)) {
    throw new Error('STACK_TREE_ROOT_NONCANONICAL');
  }
  const maxEntries=limits.maxEntries??MAX_ENTRIES;
  const maxDepth=limits.maxDepth??MAX_DEPTH;
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>MAX_ENTRIES||
      !Number.isSafeInteger(maxDepth)||maxDepth<0||maxDepth>MAX_DEPTH) {
    throw new Error('STACK_TREE_LIMIT_INVALID');
  }
  const stack:[string,number][]=[[root,0]];
  const observed:Array<readonly [string,string]>=[];
  let scannedFiles=0;
  let scannedDirectories=0;
  let verifiedAclEntries=0;
  while(stack.length) {
    const [node,depth]=stack.pop()!;
    if(node.length>MAX_PATH_LENGTH || scannedFiles+scannedDirectories>=maxEntries) {
      throw new Error('STACK_TREE_LIMIT_EXCEEDED');
    }
    const stat=lstatSync(node);
    if(stat.isSymbolicLink()) {
      throw new Error('STACK_TREE_REPARSE_OR_SYMLINK_DENIED');
    }
    if(!stat.isDirectory()&&!stat.isFile()) {
      throw new Error('STACK_TREE_NONREGULAR_NODE_DENIED');
    }
    const fingerprint=sourceFingerprint(node,stat);
    try {
      aclCheck(node);
    } catch {
      throw new Error('STACK_TREE_UNTRUSTED_ACL');
    }
    // ACL queries may take significant time. Never accept a substituted
    // source node (or contents) merely because the old path was safe.
    assertSourceUnchanged(node,fingerprint);
    observed.push([node,fingerprint]);
    verifiedAclEntries++;
    // Reject NTFS/POSIX hardlinked source: a second path may live under an
    // unverified writable parent even when this path's ACL looks private.
    if(stat.isFile()) {
      if(stat.nlink!==1)throw new Error('STACK_TREE_HARDLINK_DENIED');
      scannedFiles++;
      continue;
    }
    scannedDirectories++;
    const names=readdirSync(node);
    assertSourceUnchanged(node,fingerprint);
    if(names.length && depth>=maxDepth) {
      throw new Error('STACK_TREE_DEPTH_LIMIT_EXCEEDED');
    }
    if(names.length>maxEntries-scannedFiles-scannedDirectories) {
      throw new Error('STACK_TREE_LIMIT_EXCEEDED');
    }
    for(const name of names) {
      if(name==='.'||name==='..'||name.includes('/')||
          name.includes('\\')||name.includes(':')) {
        throw new Error('STACK_TREE_UNSAFE_CHILD_NAME');
      }
      const child=path.join(node,name);
      if(child.length>MAX_PATH_LENGTH || path.dirname(child)!==node) {
        throw new Error('STACK_TREE_NONCANONICAL_CHILD');
      }
      stack.push([child,depth+1]);
    }
  }
  // Nodes visited early might be replaced while a later ACL is checked.
  // Final read-only revalidation detects such changes within this scan.
  for(const [node,fingerprint] of observed) {
    assertSourceUnchanged(node,fingerprint);
  }
  return Object.freeze({
    scannedFiles,scannedDirectories,verifiedAclEntries,
    symlinksFollowed:false as const,
    modificationsPerformed:false as const,
    runtimeAttested:false as const,
  });
}

/**
 * PRODUCTION AUDIT: fixed Stack source root, no caller-selected path or ACL
 * callback. Can be expensive on a large dependency tree; run only during
 * owner-approved read-only maintenance, never per command.
 */
export function auditPrivilegedStackDependencyTree():ReadOnlySourceTreeInventory {
  if(process.platform!=='win32') {
    throw new Error('STACK_TREE_AUDIT_WINDOWS_ONLY');
  }
  // First demand the exact known elevated entrypoint path remains intact.
  auditPrivilegedStackSource();
  const inventory=inventoryReadOnlySourceTree(
    PRODUCTION_STACK_ROOT,verifyWindowsPrivateAcl,
  );
  // The long full-tree inventory can outlive the initial shared-ancestor
  // snapshot. Do not accept the result without another parent ACL check.
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  return inventory;
}
