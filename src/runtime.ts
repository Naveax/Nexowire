import type { NexowireConfig } from './config.js';
import { AgentBroker } from './core/agent-broker.js';
import { ProviderRegistry } from './core/provider-registry.js';
import { AgentProvider } from './providers/agent-provider.js';
import { SkillRegistry } from './skills/registry.js';
import { WorkspaceStore } from './workspace/store.js';

export function createRuntime(config: NexowireConfig) {
  const broker = new AgentBroker();
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));

  return {
    broker,
    context: {
      providers,
      workspaces: new WorkspaceStore(config.stateDir),
      skills: new SkillRegistry(config.skillsDir),
    },
  };
}
