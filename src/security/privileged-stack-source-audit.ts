import { lstatSync } from 'node:fs';
import path from 'node:path';
import { verifyWindowsPrivateAcl } from './windows-programdata-acl.js';

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
 * Read-only fail-closed audit. Each component is lstat'd (not stat'd) to
 * reject any junction/symlink traversal, then its owner/write ACL is checked
 * with the pinned Windows inbox PowerShell binary.
 */
export function auditPrivilegedStackSource(
  entrypoint: string = STACK_ENTRY,
): PrivilegedStackSourceAudit {
  const chain = privilegedStackSourceChain(entrypoint);
  for (let index = 0; index < chain.length; index++) {
    const node = chain[index]!;
    let stat;
    try {
      stat = lstatSync(node);
    } catch {
      throw new Error('PRIVILEGED_STACK_SOURCE_MISSING_OR_UNREADABLE');
    }
    if (stat.isSymbolicLink() ||
        (index === chain.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('PRIVILEGED_STACK_SOURCE_UNTRUSTED_COMPONENT');
    }
    try {
      verifyWindowsPrivateAcl(node);
    } catch {
      throw new Error('PRIVILEGED_STACK_SOURCE_UNTRUSTED_ACL');
    }
  }
  return {
    trusted: true,
    entrypoint:chain.at(-1)!,
    verifiedComponents:chain.length,
  };
}
