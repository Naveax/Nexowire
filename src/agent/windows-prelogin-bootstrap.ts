import {randomUUID} from 'node:crypto';

/**
 * Pre-login SYSTEM agent transport bootstrap only. This is not the ordinary
 * owner CORE agent, does not provide elevated mutating tools, and MUST NOT be
 * activated by a privileged task until separate protected token, identity and
 * runtime provisioning is independently verified.
 */
/**
 * Namespaced device IDs keep SYSTEM and interactive owner connections in
 * separate Hub broker slots. The Hub accepts opaque IDs up to 128 chars.
 */
const PRELOGIN_ID_PATTERN=/^prelogin-system:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createWindowsPreloginAgentIdentity():{id:string} {
  return {id:'prelogin-system:'+randomUUID()};
}

export function parseWindowsPreloginAgentIdentity(value:unknown):string {
  if(!value||typeof value!=='object'||!('id' in value)||
     typeof value.id!=='string'||!PRELOGIN_ID_PATTERN.test(value.id))
    throw new Error('PRELOGIN_AGENT_MACHINE_IDENTITY_INVALID');
  return value.id;
}

/**
 * A scheduler-level observation, not proof of an authenticated Hub session.
 * Keep the SYSTEM transport available while the interactive Agent runs: its
 * separate ID and bounded capabilities provide a non-destructive handoff.
 */
export function preloginHandoffTaskObservation(
  systemTaskState:string,ownerTaskState:string,machineIdentityValid:boolean,
):'identity-unverified'|'system-task-not-running'|'prelogin-only'|'owner-task-running' {
  if(!machineIdentityValid)return 'identity-unverified';
  if(systemTaskState.toLowerCase()!=='running')return 'system-task-not-running';
  if(ownerTaskState.toLowerCase()==='running')return 'owner-task-running';
  return 'prelogin-only';
}

const PRELOGIN_CAPABILITIES = new Set([
  'machine.health',
  'windows.tasks',
]);


/** Canonical machine-owned paths. The pre-login service cannot consult the
 * interactive owner's .nexowire profile or current-user DPAPI credentials. */
export const WINDOWS_PRELOGIN_AGENT_ROOT=String.raw`C:\ProgramData\Nexowire\system-agent`;
export const WINDOWS_PRELOGIN_AGENT_STATE_ROOT=
  WINDOWS_PRELOGIN_AGENT_ROOT+String.raw`\state`;
export const WINDOWS_PRELOGIN_AGENT_PATHS={
  NEXOWIRE_AGENT_IDENTITY_FILE:WINDOWS_PRELOGIN_AGENT_ROOT+String.raw`\agent.json`,
  NEXOWIRE_AGENT_TOKEN_DPAPI_FILE:WINDOWS_PRELOGIN_AGENT_ROOT+String.raw`\agent-token.machine.dpapi.json`,
  NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE:WINDOWS_PRELOGIN_AGENT_STATE_ROOT+String.raw`\agent-operations.sqlite`,
  NEXOWIRE_PROCESS_STATE_FILE:WINDOWS_PRELOGIN_AGENT_STATE_ROOT+String.raw`\process-sessions.json`,
  NEXOWIRE_PROCESS_WORKER_ROOT:WINDOWS_PRELOGIN_AGENT_STATE_ROOT+String.raw`\process-workers`,
  NEXOWIRE_TASK_GRAPH_STATE_FILE:WINDOWS_PRELOGIN_AGENT_STATE_ROOT+String.raw`\task-graphs.json`,
  NEXOWIRE_RUNBOOK_STATE_FILE:WINDOWS_PRELOGIN_AGENT_STATE_ROOT+String.raw`\runbooks.json`,
  NEXOWIRE_STATE_DIR:WINDOWS_PRELOGIN_AGENT_STATE_ROOT,
} as const;

/** Side-effect-free provenance contract. Runtime performs an additional ACL
 * and trusted-code-tree readback before opening either machine token or ID. */
export function assertWindowsPreloginStartupConfiguration(
  env:NodeJS.ProcessEnv,
  platform:NodeJS.Platform=process.platform,
):{root:string;stateRoot:string;identityFile:string;tokenFile:string} {
  if(!getWindowsPreloginAgentMode(env,platform))
    throw new Error('PRELOGIN_AGENT_MODE_NOT_ENABLED');
  for(const [name,expected] of Object.entries(WINDOWS_PRELOGIN_AGENT_PATHS)){
    if(env[name]!==expected)
      throw new Error('PRELOGIN_AGENT_MACHINE_PATH_REQUIRED: '+name);
  }
  if(env.NEXOWIRE_HUB_WS_URL!=='ws://127.0.0.1:43110/agent'||
     env.NEXOWIRE_HUB_WS_URLS!==undefined){
    throw new Error('PRELOGIN_AGENT_LOOPBACK_HUB_REQUIRED');
  }
  for(const name of [
    'NEXOWIRE_AGENT_TOKEN','NEXOWIRE_AGENT_TOKENS',
    'NEXOWIRE_AGENT_TOKEN_FILE','NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME',
    'NEXOWIRE_CORE_AUTHORITY_URL','NEXOWIRE_CORE_APPROVAL_MODE',
    'NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE',
    'NEXOWIRE_PRIVILEGED_BROKER_TOKEN',
    'NEXOWIRE_ALLOWED_ROOTS',
  ] as const){
    if(env[name]!==undefined)
      throw new Error('PRELOGIN_AGENT_OWNER_PROFILE_FORBIDDEN: '+name);
  }
  if(env.NEXOWIRE_PRIVILEGE_MODE!==undefined&&
     env.NEXOWIRE_PRIVILEGE_MODE!=='broker')
    throw new Error('PRELOGIN_AGENT_DIRECT_PRIVILEGE_FORBIDDEN');
  return {
    root:WINDOWS_PRELOGIN_AGENT_ROOT,
    stateRoot:WINDOWS_PRELOGIN_AGENT_STATE_ROOT,
    identityFile:WINDOWS_PRELOGIN_AGENT_PATHS.NEXOWIRE_AGENT_IDENTITY_FILE,
    tokenFile:WINDOWS_PRELOGIN_AGENT_PATHS.NEXOWIRE_AGENT_TOKEN_DPAPI_FILE,
  };
}

export function getWindowsPreloginAgentMode(
  env:NodeJS.ProcessEnv,
  platform:NodeJS.Platform=process.platform,
):boolean {
  const mode=env.NEXOWIRE_WINDOWS_PRELOGIN_AGENT;
  if(mode===undefined)return false;
  if(mode!=='1'||platform!=='win32')
    throw new Error('PRELOGIN_AGENT_MODE_REQUIRES_EXPLICIT_WINDOWS_OPT_IN');
  return true;
}

export function preloginBootstrapAllowsCapability(capability:string):boolean {
  return PRELOGIN_CAPABILITIES.has(capability);
}

export function filterWindowsPreloginCapabilities(
  capabilities:readonly string[],
  enabled:boolean,
):string[] {
  if(!enabled)return [...capabilities];
  const seen=new Set<string>();
  const result:string[]=[];
  for(const cap of capabilities) {
    if(!preloginBootstrapAllowsCapability(cap)||seen.has(cap))continue;
    seen.add(cap);
    result.push(cap);
  }
  return result;
}
