import path from 'node:path';
import type { NexowireConfig } from './config.js';
import { AuditLog } from './audit/log.js';
import { AgentBroker } from './core/agent-broker.js';
import { ProviderRegistry } from './core/provider-registry.js';
import { AgentProvider } from './providers/agent-provider.js';
import { SkillRegistry } from './skills/registry.js';
import { WorkspaceStore } from './workspace/store.js';

export async function createRuntime(config: NexowireConfig) {
  const broker = new AgentBroker();
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));
  const audit = new AuditLog(path.join(config.stateDir, 'audit.jsonl'));
  await audit.loadRecent();

  return {
    broker,
    context: {
      providers,
      audit,
      workspaces: new WorkspaceStore(config.stateDir),
      skills: new SkillRegistry(config.skillsDir),
    },
  };
}
