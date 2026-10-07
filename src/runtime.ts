import path from 'node:path';
import type { NexowireConfig } from './config.js';
import { AuditLog } from './audit/log.js';
import { AgentBroker } from './core/agent-broker.js';
import { ProviderRegistry } from './core/provider-registry.js';
import { DeviceAliasStore } from './devices/alias-store.js';
import { DeviceDirectory } from './devices/directory.js';
import { DeviceGroupStore } from './devices/group-store.js';
import { DeviceRoutingPolicyStore } from './devices/routing-policy-store.js';
import { IdempotencyStore } from './operations/idempotency-store.js';
import { CapabilityPolicyStore } from './security/capability-policy.js';
import { CredentialStore } from './security/credential-store.js';
import { AgentProvider } from './providers/agent-provider.js';
import { SkillRegistry } from './skills/registry.js';
import { WorkspaceStore } from './workspace/store.js';
import { createControlPlaneAgentPresenceReporter } from './hub/control-plane-agent-auth.js';

export async function createRuntime(config: NexowireConfig) {
  const devices = new DeviceDirectory(config.stateDir);
  await devices.initialize();

  const reportControlPlanePresence =
    config.controlPlaneAgentAuth
      ? createControlPlaneAgentPresenceReporter({
          controlPlaneUrl: config.controlPlaneAgentAuth.url,
          serviceToken:
            config.controlPlaneAgentAuth.serviceToken,
          ...(config.controlPlaneAgentAuth.timeoutMs !== undefined
            ? {
                timeoutMs:
                  config.controlPlaneAgentAuth.timeoutMs,
              }
            : {}),
        })
      : undefined;

  const broker = new AgentBroker({
    onDeviceState: async (event) => {
      if (event.type === 'connected') {
        await devices.observeConnected(event.device, event.at);
      } else {
        await devices.observeDisconnected(event.device.id, event.at);
      }
      if (reportControlPlanePresence) {
        await reportControlPlanePresence({
          deviceId: event.device.id,
          online: event.type === 'connected',
          at: event.at,
          ...(event.type === 'connected'
            ? {
                agentVersion: event.device.agentVersion,
                privilegeMode: event.device.privilegeMode,
                adminBridgeReady:
                  event.device.adminBridgeReady,
              }
            : {}),
        });
      }
    },
  });
  const providers = new ProviderRegistry();
  providers.register(new AgentProvider(broker));

  const audit = new AuditLog(path.join(config.stateDir, 'audit.jsonl'));
  const aliases = new DeviceAliasStore(config.stateDir);
  const groups = new DeviceGroupStore(config.stateDir);
  const routingPolicies = new DeviceRoutingPolicyStore(config.stateDir);
  const idempotency = new IdempotencyStore(config.stateDir);
  const policies = new CapabilityPolicyStore(config.stateDir);
  const credentials = new CredentialStore(config.stateDir);
  await Promise.all([
    audit.loadRecent(),
    aliases.initialize(),
    groups.initialize(),
    routingPolicies.initialize(),
    idempotency.initialize(),
    policies.initialize(),
    credentials.initialize(),
  ]);

  return {
    broker,
    context: {
      broker,
      providers,
      devices,
      aliases,
      groups,
      routingPolicies,
      idempotency,
      policies,
      credentials,
      audit,
      workspaces: new WorkspaceStore(config.stateDir),
      skills: new SkillRegistry(config.skillsDir),
    },
  };
}
