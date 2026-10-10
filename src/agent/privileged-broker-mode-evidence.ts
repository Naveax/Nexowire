import { connect } from 'node:net';
import {
  privilegedBrokerTaskStatus,
  probePrivilegedBrokerHealth,
  type PrivilegedBrokerTaskOptions,
  type PrivilegedBrokerTaskStatus,
  type PrivilegedBrokerHealthReport,
} from './privileged-broker-lifecycle.js';

export type PrivilegedBrokerDesiredMode = 'auto' | 'on' | 'off';
export type LoopbackListenerState = 'present' | 'absent' | 'unverified';

export interface BrokerModeEvidence {
  desiredMode: PrivilegedBrokerDesiredMode;
  taskState: string | null;
  taskVerified: boolean;
  brokerHealth: 'authenticated-ready' | 'absent' | 'unverified';
  applied: boolean;
}

/**
 * Read-only TCP observation: only ECONNREFUSED proves absence. Timeout,
 * ACCESS_DENIED, DNS errors and other transport failures are not evidence.
 */
export async function probeBrokerLoopbackListener(
  port = 43112,
  timeoutMs = 750,
): Promise<LoopbackListenerState> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
    throw new Error('BROKER_LOOPBACK_PROBE_INVALID_ARGUMENT');
  }
  return await new Promise<LoopbackListenerState>((resolve) => {
    let settled = false;
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (state: LoopbackListenerState): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.once('connect', () => finish('present'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'absent' : 'unverified');
    });
    socket.setTimeout(timeoutMs, () => finish('unverified'));
  });
}

export function classifyPrivilegedBrokerModeEvidence(
  desiredMode: PrivilegedBrokerDesiredMode,
  task: PrivilegedBrokerTaskStatus,
  listener: LoopbackListenerState,
  health: PrivilegedBrokerHealthReport | null,
): BrokerModeEvidence {
  const trustedTask = task.installed &&
    task.taskName === 'Nexowire Privileged Broker';
  if (desiredMode === 'off') {
    const complete = trustedTask && task.state === 'Disabled' &&
      listener === 'absent';
    return {
      desiredMode,
      taskState: task.state,
      taskVerified: trustedTask && task.state === 'Disabled',
      brokerHealth: listener === 'absent' ? 'absent' : 'unverified',
      applied: complete,
    };
  }
  const ready = health?.status === 'READY' && health.ready &&
    health.reachable && health.elevated &&
    health.version === health.expectedVersion && listener === 'present';
  const complete = Boolean(trustedTask && task.state === 'Running' && ready);
  return {
    desiredMode,
    taskState: task.state,
    taskVerified: trustedTask && task.state === 'Running',
    brokerHealth: ready ? 'authenticated-ready' : 'unverified',
    applied: complete,
  };
}

/**
 * No Windows task mutation. Never infer health from task status alone.
 * A remote owner receipt additionally requires authenticated transport,
 * pairing-bound intent validation and an atomic replay/ack ledger.
 */
export async function verifyPrivilegedBrokerModePostcondition(
  desiredMode: PrivilegedBrokerDesiredMode,
  options: {
    env?: NodeJS.ProcessEnv;
    taskOptions?: PrivilegedBrokerTaskOptions;
    readTask?: () => Promise<PrivilegedBrokerTaskStatus>;
    readHealth?: () => Promise<PrivilegedBrokerHealthReport>;
    probeListener?: () => Promise<LoopbackListenerState>;
  } = {},
): Promise<BrokerModeEvidence> {
  if (desiredMode !== 'auto' && desiredMode !== 'on' && desiredMode !== 'off') {
    throw new Error('BROKER_MODE_INVALID');
  }
  const env = options.env ?? process.env;
  const customUrl = env.NEXOWIRE_PRIVILEGED_BROKER_URL?.trim();
  if (customUrl) {
    let endpoint: URL;
    try { endpoint = new URL(customUrl); } catch {
      throw new Error('BROKER_NONCANONICAL_HEALTH_ENDPOINT');
    }
    if (endpoint.href !== 'http://127.0.0.1:43112/') {
      throw new Error('BROKER_NONCANONICAL_HEALTH_ENDPOINT');
    }
  }
  const task = await (options.readTask ??
    (() => privilegedBrokerTaskStatus(options.taskOptions)))();
  const listener = await (options.probeListener ??
    (() => probeBrokerLoopbackListener()))();
  const health = desiredMode === 'off' ? null : await (options.readHealth ??
    (() => probePrivilegedBrokerHealth({env})))();
  return classifyPrivilegedBrokerModeEvidence(
    desiredMode, task, listener, health,
  );
}
