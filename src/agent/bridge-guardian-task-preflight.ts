import { lstatSync, readdirSync } from 'node:fs';
import * as z from 'zod';
import { verifyWindowsPrivateAcl } from '../security/windows-programdata-acl.js';

export const BRIDGE_GUARDIAN_TASK_NAME = 'Nexowire Bridge Guardian';
export const BRIDGE_GUARDIAN_SOURCE_ROOT =
  'C:\\ProgramData\\Nexowire\\bridge-guardian';
export const BRIDGE_GUARDIAN_LAUNCHER =
  BRIDGE_GUARDIAN_SOURCE_ROOT + '\\launch.ps1';
export const BRIDGE_GUARDIAN_POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const EXPECTED_ARGS =
  '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
  BRIDGE_GUARDIAN_LAUNCHER + '"';

const taskSnapshot = z.strictObject({
  name: z.string(),
  taskPath: z.string(),
  state: z.enum(['Running','Ready','Disabled','Unknown']),
  principal: z.strictObject({
    /** Translate Task Scheduler principal to SID in the trusted Windows collector. */
    userSid: z.string(),
    runLevel: z.enum(['Highest','Limited']),
    logonType: z.enum(['Interactive','Password','ServiceAccount']),
  }),
  actions: z.array(z.strictObject({
    execute: z.string(),
    arguments: z.string(),
    workingDirectory: z.string(),
  })).max(5),
  triggers: z.array(z.strictObject({
    type: z.enum(['Logon','Time','Other']),
    userSid: z.string().nullable(),
    enabled: z.boolean(),
  })).max(32),
});

export type BridgeGuardianTaskSnapshot = z.infer<typeof taskSnapshot>;

export interface BridgeGuardianTaskVerification {
  readonly taskName: typeof BRIDGE_GUARDIAN_TASK_NAME;
  readonly state: 'Running';
  readonly principalSid: string;
  readonly actionVerified: true;
  readonly logonTriggerVerified: true;
  /** Task identity is NOT proof of protected source or live Hub connection. */
  readonly sourceAclVerified: false;
  readonly hubChannelVerified: false;
}

/**
 * Verify a trusted Windows collector's Scheduled Task snapshot. This rejects
 * aliases, unknown actions, extra flags and a mismatched interactive SID.
 * It cannot prove the collector itself is trusted or that the task really ran.
 */
export function verifyBridgeGuardianTaskSnapshot(
  raw: unknown,
  expectedCurrentUserSid: string,
): BridgeGuardianTaskVerification {
  if (!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(expectedCurrentUserSid)) {
    throw new Error('BRIDGE_GUARDIAN_CURRENT_USER_SID_INVALID');
  }
  const task = taskSnapshot.parse(raw);
  if (task.name !== BRIDGE_GUARDIAN_TASK_NAME ||
      task.taskPath !== '\\' ||
      task.state !== 'Running' ||
      task.principal.userSid !== expectedCurrentUserSid ||
      task.principal.runLevel !== 'Highest' ||
      task.principal.logonType !== 'Interactive') {
    throw new Error('BRIDGE_GUARDIAN_TASK_IDENTITY_UNVERIFIED');
  }

  if (task.actions.length !== 1) {
    throw new Error('BRIDGE_GUARDIAN_TASK_ACTION_UNVERIFIED');
  }
  const action = task.actions[0]!;
  if (action.execute.toLowerCase() !== BRIDGE_GUARDIAN_POWERSHELL.toLowerCase() ||
      action.arguments !== EXPECTED_ARGS ||
      (action.workingDirectory.toLowerCase() !==
        BRIDGE_GUARDIAN_SOURCE_ROOT.toLowerCase())) {
    throw new Error('BRIDGE_GUARDIAN_TASK_ACTION_UNVERIFIED');
  }

  // Any additional, duplicated, disabled or unknown triggers must deny
  // trust. One expected logon trigger is NOT enough if a second trigger
  // can start the protected task in an unreviewed context.
  if (task.triggers.length !== 1 ||
      task.triggers[0]?.type !== 'Logon' ||
      task.triggers[0].enabled !== true ||
      task.triggers[0].userSid !== expectedCurrentUserSid) {
    throw new Error('BRIDGE_GUARDIAN_TASK_LOGON_TRIGGER_UNVERIFIED');
  }

  return Object.freeze({
    taskName: BRIDGE_GUARDIAN_TASK_NAME,
    state: 'Running' as const,
    principalSid: expectedCurrentUserSid,
    actionVerified: true as const,
    logonTriggerVerified: true as const,
    sourceAclVerified: false as const,
    hubChannelVerified: false as const,
  });
}

/**
 * Pure read-only inspection mechanism for a chain ending in a file.
 * The caller-supplied path and ACL callback are NOT authority to run tasks.
 * A privileged caller MUST use the separately pinned wrapper below.
 */
export function inspectGuardianSourceChainSnapshotOnly(
  paths:readonly string[],
  checkAcl:(absolutePath:string)=>void,
):void {
  if(paths.length<2 || paths.length>16) {
    throw new Error('BRIDGE_GUARDIAN_SOURCE_CHAIN_INVALID');
  }
  const fingerprint=(
    item:string,stat:NonNullable<ReturnType<typeof lstatSync>>,
  ):string=>JSON.stringify([
    stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,
    stat.mtimeMs,stat.ctimeMs,stat.birthtimeMs,
    stat.isFile(),stat.isDirectory(),stat.isSymbolicLink(),
    // NTFS directory metadata timestamps are not a reliable signal that
    // children appeared or disappeared during inspection.
    stat.isDirectory()?readdirSync(item).sort():null,
  ]);
  const observed:Array<readonly [string,string]>=[];
  const assertUnchanged=(item:string,initial:string):void=>{
    let current;
    try {
      current=lstatSync(item);
    } catch {
      throw new Error('BRIDGE_GUARDIAN_SOURCE_CHANGED_DURING_AUDIT');
    }
    if(fingerprint(item,current)!==initial) {
      throw new Error('BRIDGE_GUARDIAN_SOURCE_CHANGED_DURING_AUDIT');
    }
  };
  for(let index=0;index<paths.length;index++){
    const item=paths[index]!;
    let stat;
    try {
      stat=lstatSync(item);
    } catch {
      throw new Error('BRIDGE_GUARDIAN_SOURCE_MISSING_OR_UNREADABLE');
    }
    if (stat.isSymbolicLink() ||
        (index === paths.length-1 ?
          !stat.isFile() || stat.nlink!==1 : !stat.isDirectory())) {
      throw new Error('BRIDGE_GUARDIAN_SOURCE_UNTRUSTED_TYPE');
    }
    const initial=fingerprint(item,stat);
    try {
      checkAcl(item);
    } catch {
      throw new Error('BRIDGE_GUARDIAN_SOURCE_UNTRUSTED_ACL');
    }
    assertUnchanged(item,initial);
    observed.push([item,initial]);
  }
  // Recheck ancestors: they can be replaced while a later ACL is measured.
  for(const [item,initial] of observed) {
    assertUnchanged(item,initial);
  }
}

/**
 * Read-only ACL/reparse check for a future, separately installed Guardian.
 * No installer is provided and the protected path is expected to be absent
 * on the current production Agent. Absence is a failure, not permission.
 */
export function verifyBridgeGuardianSourceAcl(): void {
  if (process.platform !== 'win32') {
    throw new Error('BRIDGE_GUARDIAN_WINDOWS_ONLY');
  }
  inspectGuardianSourceChainSnapshotOnly([
    'C:\\ProgramData\\Nexowire',
    BRIDGE_GUARDIAN_SOURCE_ROOT,
    BRIDGE_GUARDIAN_LAUNCHER,
  ],verifyWindowsPrivateAcl);
}
