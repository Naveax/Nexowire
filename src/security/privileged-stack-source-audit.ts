import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { verifyWindowsPrivateAcl, verifyWindowsStackOuterAncestorAcl } from './windows-programdata-acl.js';

const STACK_ROOT = 'C:\\ProgramData\\NexowireStack';
const STACK_ENTRY = STACK_ROOT +
  '\\nexowire\\node_modules\\nexowire\\dist\\src\\cli.js';

/**
 * The live elevated Stack's current known executable entrypoint. Before a
 * production cutover, its entire source path must be protected from writes
 * by non-administrators. This audit never changes a file or Scheduled Task.
 */
export function privilegedStackSourceChain(
  entrypoint: string = STACK_ENTRY,
): readonly string[] {
  if (process.platform !== 'win32') {
    throw new Error('PRIVILEGED_STACK_SOURCE_AUDIT_WINDOWS_ONLY');
  }
  const input = entrypoint.trim();
  if (!input || input !== entrypoint ||
      input.startsWith('\\\\') ||
      input.includes('/') ||
      input.split('\\').includes('..') ||
      input.split('\\').includes('.')) {
    throw new Error('PRIVILEGED_STACK_SOURCE_NONCANONICAL_PATH');
  }
  if (
    path.win32.resolve(input).toLowerCase() !== STACK_ENTRY.toLowerCase() ||
    path.win32.normalize(input).toLowerCase() !== STACK_ENTRY.toLowerCase()
  ) {
    throw new Error('PRIVILEGED_STACK_SOURCE_NONCANONICAL_PATH');
  }
  const output = [STACK_ROOT];
  let cursor = STACK_ROOT;
  for (const segment of ['nexowire', 'node_modules', 'nexowire', 'dist', 'src', 'cli.js']) {
    cursor = path.win32.join(cursor, segment);
    output.push(cursor);
  }
  return output;
}

export interface PrivilegedStackSourceAudit {
  readonly trusted: true;
  readonly entrypoint: string;
  readonly verifiedComponents: number;
}

/**
 * Testable read-only mechanism, not trusted collection or OS authority.
 * A caller-supplied chain or ACL callback cannot certify production state.
 */
export function inspectPrivilegedStackSourceChainReadOnly(
  chain:readonly string[],
  aclCheck:(absolutePath:string)=>void,
):number {
  if(chain.length<2 || chain.length>16){
    throw new Error('PRIVILEGED_STACK_SOURCE_CHAIN_INVALID');
  }
  const fingerprint=(node:string,stat:NonNullable<ReturnType<typeof lstatSync>>):string=>
    JSON.stringify([
      stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,
      stat.mtimeMs,stat.ctimeMs,stat.birthtimeMs,
      stat.isFile(),stat.isDirectory(),stat.isSymbolicLink(),
      // NTFS parent timestamps may not reveal child creation/removal.
      stat.isDirectory()?readdirSync(node).sort():null,
    ]);
  const assertUnchanged=(node:string,before:string):void=>{
    let after:string;
    try {
      const current=lstatSync(node);
      after=fingerprint(node,current);
    } catch {
      throw new Error('PRIVILEGED_STACK_SOURCE_CHANGED_DURING_AUDIT');
    }
    if(after!==before){
      throw new Error('PRIVILEGED_STACK_SOURCE_CHANGED_DURING_AUDIT');
    }
  };
  const observed:Array<readonly [string,string]>=[];
  for (let index=0;index<chain.length;index++) {
    const node=chain[index]!;
    let stat;
    try {
      stat=lstatSync(node);
    } catch {
      throw new Error('PRIVILEGED_STACK_SOURCE_MISSING_OR_UNREADABLE');
    }
    if (stat.isSymbolicLink() ||
        (index===chain.length-1 ? !stat.isFile() || stat.nlink!==1 : !stat.isDirectory())) {
      throw new Error('PRIVILEGED_STACK_SOURCE_UNTRUSTED_COMPONENT');
    }
    let before:string;
    try {
      before=fingerprint(node,stat);
    } catch {
      throw new Error('PRIVILEGED_STACK_SOURCE_MISSING_OR_UNREADABLE');
    }
    try {
      aclCheck(node);
    } catch {
      throw new Error('PRIVILEGED_STACK_SOURCE_UNTRUSTED_ACL');
    }
    assertUnchanged(node,before);
    observed.push([node,before]);
  }
  // An ancestor can change while a later component's ACL is inspected.
  for(const [node,before] of observed){
    assertUnchanged(node,before);
  }
  return observed.length;
}

/**
 * Production wrapper pins the live Stack entrypoint and Windows ACL verifier.
 * This audit does not confer runtime attestation or privilege to run tasks.
 */
export function auditPrivilegedStackSource(
  entrypoint:string=STACK_ENTRY,
):PrivilegedStackSourceAudit {
  const chain=privilegedStackSourceChain(entrypoint);
  // The Stack root is private, but Windows shared ancestors are not. Check
  // the outer C:\ and C:\ProgramData replacement/delete/owner rights
  // before and after the potentially slow source-chain inventory.
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  const count=inspectPrivilegedStackSourceChainReadOnly(chain,verifyWindowsPrivateAcl);
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  return {
    trusted:true,
    entrypoint:chain.at(-1)!,
    verifiedComponents:count,
  };
}
