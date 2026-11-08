import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrivilegedBrokerClient } from './privileged-broker-client.js';
import { WindowsLocalOwnerCoreStore } from './local-owner-core-console.js';
import { createWindowsCoreConsoleAdmission } from './windows-core-console-provider.js';

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LocalOwnerBrokerAdmission {
  authorizeOnce(operationId: unknown): Promise<void>;
  close(): void;
}

export function requestedBrokerEffectMode(
  env: NodeJS.ProcessEnv,
): 'external' | 'local-owner' {
  const mode = env.NEXOWIRE_PRIVILEGED_BROKER_EFFECT_MODE?.trim() || 'external';
  if (mode !== 'external' && mode !== 'local-owner')
    throw new Error('BROKER_EFFECT_MODE_INVALID');
  return mode;
}

/** The privileged RUN mode is selected by the protected task action's literal
 * argv, NOT by a user-modifiable environment variable inherited by the task. */
export function brokerRunEffectMode(args: readonly string[]): 'external' | 'local-owner' {
  if (args.length === 0) return 'external';
  if (args.length === 1 && args[0] === '--local-owner-effects') return 'local-owner';
  throw new Error('BROKER_RUN_ARGUMENTS_INVALID');
}

/**
 * Local owner mode deliberately has weaker proof than independent signed CAS.
 * Never infer it from /execute JSON, bearer possession, or a READY health
 * response. The protected Broker launcher selects it at process startup.
 *
 * The local DPAPI enrollment is checked against current cloud epochs twice,
 * with an OS-atomic durable UUID reservation in between. A lost response burns
 * the UUID rather than replaying a privileged mutation.
 */
export function createLocalOwnerBrokerAdmission(options: {
  readStatus(): Promise<{ active: boolean; localEnrolled: boolean; state: string }>;
  reserve(operationId: string): Promise<void>;
  close?(): void;
}): LocalOwnerBrokerAdmission {
  let closed = false;
  const requireActive = async () => {
    const status = await options.readStatus();
    if (closed || status.active !== true || status.localEnrolled !== true ||
        status.state !== 'ACTIVE_LOCAL_OWNER')
      throw Object.assign(new Error('BROKER_LOCAL_OWNER_NOT_ACTIVE'),
        { code: 'BROKER_LOCAL_OWNER_NOT_ACTIVE' });
  };
  return {
    async authorizeOnce(operationId: unknown): Promise<void> {
      if (closed || typeof operationId !== 'string' ||
          !OPERATION_ID.test(operationId))
        throw Object.assign(new Error('BROKER_LOCAL_OWNER_REQUEST_ID_REQUIRED'),
          { code: 'BROKER_LOCAL_OWNER_REQUEST_ID_REQUIRED' });
      await requireActive();
      // No retry if the operation was previously RESERVED or its result is
      // UNKNOWN. WindowsLocalOwnerCoreStore uses exclusive create ('wx').
      try {
        await options.reserve(operationId);
      } catch (error) {
        if (error instanceof Error &&
            ('code' in error ? error.code === 'EEXIST' : error.message === 'EEXIST'))
          throw Object.assign(new Error('BROKER_LOCAL_OWNER_OPERATION_ALREADY_RECORDED'),
            { code: 'BROKER_LOCAL_OWNER_OPERATION_ALREADY_RECORDED' });
        throw error;
      }
      await requireActive();
    },
    close() { closed = true; options.close?.(); },
  };
}

/** Invoked only by the trusted elevated Broker composition root. */
export async function createWindowsLocalOwnerBrokerAdmission(
  env: NodeJS.ProcessEnv,
  brokerToken: string,
): Promise<LocalOwnerBrokerAdmission> {
  if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED');
  const { agentTokenFromEnv } = await import('./native-agent.js');
  const credential = agentTokenFromEnv(env);
  const identityFile = env.NEXOWIRE_AGENT_IDENTITY_FILE?.trim() ||
    path.join(os.homedir(), '.nexowire', 'agent.json');
  // Do not create a new identity just because the Broker started first.
  const identity = JSON.parse(await fs.readFile(identityFile, 'utf8')) as { id?: unknown };
  if (typeof identity.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.id))
    throw Error('BROKER_LOCAL_OWNER_AGENT_IDENTITY_REQUIRED');
  if (!credential) throw Error('BROKER_LOCAL_OWNER_AGENT_CREDENTIAL_REQUIRED');
  const broker = new PrivilegedBrokerClient({
    url: env.NEXOWIRE_PRIVILEGED_BROKER_URL?.trim() ||
      'http://127.0.0.1:43112',
    token: brokerToken,
  });
  const admission = await createWindowsCoreConsoleAdmission({
    deviceId: identity.id,
    credential,
    broker,
    env: { ...env, NEXOWIRE_CORE_APPROVAL_MODE: 'local-owner' },
  });
  const store = new WindowsLocalOwnerCoreStore();
  return createLocalOwnerBrokerAdmission({
    readStatus: () => admission.status('full'),
    reserve: id => store.reserve(id),
    close: () => admission.close(),
  });
}
