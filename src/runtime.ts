import path from 'node:path';
import type { NexowireConfig } from './config.js';
import { AuditLog } from './audit/log.js';
import { AgentBroker } from './core/agent-broker.js';
import { ProviderRegistry } from './core/provider-registry.js';
import { DeviceAliasStore } from './devices/alias-store.js';
import { DeviceDirectory } from './devices/directory.js';
import { IdempotencyStore } from './operations/idempotency-store.js';
import { AgentProvider } from './providers/agent-provider.js';
import { SkillRegistry } from './skills/registry.js';
import { WorkspaceStore } from './workspace/store.js';

export async function createRuntime(config: NexowireConfig) {
  const devices = new DeviceDirectory(config.stateDir);
  await devices.initialize();

  const broker = new AgentBroker({
    onDeviceState: async (event) => {
      if (event.type === 'connected') {
        await devices.observeConnected(event.device, event.at);
      } else {
        await devices.observeDisconnected(event.device.id, event.at);
      }
    },
  });
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));

  const audit = new AuditLog(path.join(config.stateDir, 'audit.jsonl'));
  const aliases = new DeviceAliasStore(config.stateDir);
  const idempotency = new IdempotencyStore(config.stateDir);
  await Promise.all([
    audit.loadRecent(),
    aliases.initialize(),
    idempotency.initialize(),
  ]);

  return {
    broker,
    context: {
      broker,
      providers,
      devices,
      aliases,
      idempotency,
      audit,
      workspaces: new WorkspaceStore(config.stateDir),
      skills: new SkillRegistry(config.skillsDir),
    },
  };
}
