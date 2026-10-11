import {lstatSync} from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import {verifyWindowsPrivateAcl} from './windows-programdata-acl.js';
import {auditPrivilegedStackDependencyTree} from './privileged-stack-tree-audit.js';

export const STACK_TASK='Nexowire Stack';
export const STACK_ROOT='C:\\ProgramData\\NexowireStack';
export const STACK_LAUNCHER=STACK_ROOT+'\\run-stack.ps1';
export const WINDOWS_POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const STACK_LAUNCH_ARGS=
  '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+
  STACK_LAUNCHER+'"';

/** A prospective protected cutover policy. NOT the existing production task. */
const snapshotSchema=z.strictObject({
  name:z.literal(STACK_TASK),
  taskPath:z.literal('\\'),
  state:z.enum(['Running','Ready','Disabled','Unknown']),
  principal:z.strictObject({
    userSid:z.string(),
    runLevel:z.enum(['Highest','Limited']),
    logonType:z.enum(['Interactive','Password','ServiceAccount']),
  }),
  actions:z.array(z.strictObject({
    execute:z.string(),
    arguments:z.string(),
    workingDirectory:z.string(),
  })).max(8),
  triggers:z.array(z.strictObject({
    type:z.enum(['Logon','Time','Other']),
    userSid:z.string().nullable(),
    enabled:z.boolean(),
  })).max(16),
});

export interface PrivilegedStackTaskChainReview {
  readonly taskIdentityVerified:true;
  readonly protectedLauncherChainVerified:false;
  readonly protectedDependencyTreeVerified:false;
  readonly taskAclVerified:false;
  readonly runningProcessAttested:false;
  readonly remoteActuationAuthorized:false;
}

const SID=/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/;

/**
 * Pure strict task snapshot identity check for a FUTURE reviewed owner cutover.
 * A valid caller-supplied JSON object is NOT trusted collection or attestation.
 */
export function verifyPrivilegedStackTaskSnapshot(
  raw:unknown,
  expectedCurrentUserSid:string,
):PrivilegedStackTaskChainReview {
  if(!SID.test(expectedCurrentUserSid)){
    throw new Error('STACK_TASK_CURRENT_USER_SID_UNVERIFIED');
  }
  const task=snapshotSchema.parse(raw);
  if(task.state!=='Running' ||
      task.principal.userSid!==expectedCurrentUserSid ||
      task.principal.runLevel!=='Highest' ||
      task.principal.logonType!=='Interactive' ||
      task.actions.length!==1 || task.triggers.length!==1) {
    throw new Error('STACK_TASK_IDENTITY_UNVERIFIED');
  }
  const action=task.actions[0]!;
  if(action.execute.toLowerCase()!==WINDOWS_POWERSHELL.toLowerCase() ||
      action.arguments!==STACK_LAUNCH_ARGS ||
      action.workingDirectory.toLowerCase()!==STACK_ROOT.toLowerCase()) {
    throw new Error('STACK_TASK_UNPROTECTED_ACTION_DENIED');
  }
  const trigger=task.triggers[0]!;
  if(trigger.type!=='Logon'||!trigger.enabled ||
      trigger.userSid!==expectedCurrentUserSid) {
    throw new Error('STACK_TASK_TRIGGER_UNVERIFIED');
  }
  return Object.freeze({
    taskIdentityVerified:true as const,
    protectedLauncherChainVerified:false as const,
    protectedDependencyTreeVerified:false as const,
    taskAclVerified:false as const,
    runningProcessAttested:false as const,
    remoteActuationAuthorized:false as const,
  });
}

export interface PrivilegedStackLauncherReadOnlyAudit {
  readonly launcher:typeof STACK_LAUNCHER;
  readonly aclComponentsVerified:2;
  readonly sourceDependencyNodesChecked:number;
  readonly sourceTreeRuntimeAttested:false;
  readonly productionTaskRetargeted:false;
  readonly remoteActuationAuthorized:false;
}

/**
 * Read-only maintenance audit for an already installed protected candidate.
 * Must NOT be called as a per-command hot path. This never writes Task/ACL.
 */
export function auditProtectedPrivilegedStackLauncherReadOnly():
    PrivilegedStackLauncherReadOnlyAudit {
  if(process.platform!=='win32') {
    throw new Error('STACK_TASK_WINDOWS_ONLY');
  }
  for(const p of [STACK_ROOT,STACK_LAUNCHER]) {
    const st=lstatSync(p);
    if(st.isSymbolicLink() ||
      (p===STACK_LAUNCHER ? !st.isFile()||st.nlink!==1 : !st.isDirectory()) ||
      path.win32.normalize(p).toLowerCase()!==p.toLowerCase()) {
      throw new Error('STACK_TASK_LAUNCHER_SOURCE_UNTRUSTED');
    }
    verifyWindowsPrivateAcl(p);
  }
  const inventory=auditPrivilegedStackDependencyTree();
  return Object.freeze({
    launcher:STACK_LAUNCHER,
    aclComponentsVerified:2 as const,
    sourceDependencyNodesChecked:inventory.verifiedAclEntries,
    sourceTreeRuntimeAttested:false as const,
    productionTaskRetargeted:false as const,
    remoteActuationAuthorized:false as const,
  });
}
