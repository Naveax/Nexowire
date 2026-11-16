import {createHash} from 'node:crypto';
import {NEXOWIRE_VERSION} from '../version.js';

/**
 * Deliberately untrusted, in-process model of CORE policy decisions.
 * This module has no reference to the Agent, Broker, Windows API, shell,
 * filesystem, network, token storage, or native effect dispatch.
 */
export const DANGER_LAB_VERSION = '1.0.9-exp0-danger';
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_CAPABILITY_LENGTH = 128;

export interface DangerLabDecision {
  readonly release: typeof DANGER_LAB_VERSION;
  readonly mode: 'OFFLINE_SIMULATION';
  readonly decision: 'SIMULATED_ALLOW';
  readonly capability: string;
  readonly payloadSha256: string;
  readonly authenticated: false;
  readonly executed: false;
  readonly hostEffects: false;
  readonly fullCoreAccessVerified: false;
  readonly networkListenerCreated: false;
  readonly warning: string;
}

export function simulateDangerLabRequest(capability: unknown, payload: unknown): DangerLabDecision {
  if (typeof capability !== 'string' || capability.length === 0 ||
      capability.length > MAX_CAPABILITY_LENGTH || /[\x00-\x1f\x7f]/.test(capability)) {
    throw Error('DANGER_LAB_CAPABILITY_INVALID');
  }
  const encoded = JSON.stringify(payload);
  if (encoded === undefined) throw Error('DANGER_LAB_PAYLOAD_NOT_JSON');
  const bytes = Buffer.from(encoded, 'utf8');
  if (bytes.length > MAX_PAYLOAD_BYTES) throw Error('DANGER_LAB_PAYLOAD_TOO_LARGE');
  return {
    release: DANGER_LAB_VERSION,
    mode: 'OFFLINE_SIMULATION',
    decision: 'SIMULATED_ALLOW',
    capability,
    payloadSha256: createHash('sha256').update(bytes).digest('hex'),
    authenticated: false,
    executed: false,
    hostEffects: false,
    fullCoreAccessVerified: false,
    networkListenerCreated: false,
    warning: 'Policy is bypassed only in this inert simulation; live Nexowire security is unchanged.',
  };
}

export function dangerLabStatus() {
  return {
    release: DANGER_LAB_VERSION,
    simulatedSecurityGates: 'OFF_IN_MODEL_ONLY',
    actualSecurityGates: 'UNCHANGED',
    networkListenerCreated: false,
    physicalCoreActivated: false,
    hostEffectsAllowed: false,
    scope: 'EXPLICIT_LOCAL_CLI_ONLY',
  } as const;
}

export async function runDangerLabCommand(args: readonly string[]): Promise<void> {
  if (NEXOWIRE_VERSION !== DANGER_LAB_VERSION) {
    throw Error('DANGER_LAB_RELEASE_REQUIRED');
  }
  const command = args[0] ?? 'status';
  if (command === 'status' && args.length === 1 || command === 'status' && args.length === 0) {
    process.stdout.write(JSON.stringify(dangerLabStatus()) + '\n');
    return;
  }
  if (command !== 'simulate' || args.length < 2 || args.length > 3) {
    throw Error('Usage: nexowire danger-lab status|simulate <capability> [text]');
  }
  // An opaque test string avoids shell-specific nested JSON quoting and is
  // fingerprinted, never interpreted as a command or returned to the caller.
  const payload: unknown = args[2] ?? null;
  process.stdout.write(JSON.stringify(simulateDangerLabRequest(args[1], payload)) + '\n');
}
