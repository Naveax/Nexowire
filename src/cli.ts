#!/usr/bin/env node
import { runNativeAgent } from './agent/native-agent.js';
import { runConnectCommand } from './connect.js';
import { runNativeAgentLifecycleCommand } from './agent/native-agent-lifecycle.js';
import { runNativeAgentEnrollmentCommand } from './agent/native-agent-enrollment.js';
import { runProcessWorker } from './agent/process-worker.js';
import { loadConfig } from './config.js';
import { runHttpServer } from './mcp/http.js';
import { runLocalFirstIngress, verifyLocalFirstPublicUpstream } from './mcp/local-first-ingress.js';
import { readOnlyLocalFirstFunnelPlan } from './mcp/local-first-funnel-plan.js';
import { runCloudflareConnection } from './mcp/local-first-cloudflare.js';
import { runStdioServer } from './mcp/stdio.js';
import { createRuntime } from './runtime.js';
import { loadRelayConfig } from './relay/config.js';
import { runRelayServer } from './relay/server.js';
import { runPrivilegedBroker } from './agent/privileged-broker.js';
import { runPrivilegedBrokerLifecycleCommand } from './agent/privileged-broker-lifecycle.js';
import { runCredentialCommand } from './security/credentials-cli.js';
import { runProtectedSecretCommand } from './security/protected-secrets-cli.js';
import { CredentialStore } from './security/credential-store.js';
import { evaluateDeploymentReadiness } from './security/deployment-readiness.js';
import { runDeploymentOnboardingCommand } from './security/deployment-onboarding.js';
import { NEXOWIRE_VERSION } from './version.js';
import { runTailscaleCommand } from './tailscale-exposure.js';
import { runHubLifecycleCommand } from './hub/hub-lifecycle.js';
import { runHubBootLifecycleCommand } from './hub/hub-boot-lifecycle.js';
import {
  runSelfHostedNodeCommand,
  selfHostedConnectorInfo,
} from './self-host-bootstrap.js';
import { runLiveUpdateCommand } from './update/live-update.js';
import { runAutoUpdateCommand } from './update/auto-update.js';

function printHelp(): void {
  process.stdout.write(`
Nexowire ${NEXOWIRE_VERSION}

Usage:
  nexowire http    Start the MCP hub and native-agent WebSocket endpoint
  nexowire stdio   Start an MCP server over stdio
  nexowire agent [run|enroll|doctor|status|install|start|stop|restart|uninstall]\n                   Enroll, diagnose, run, or manage the native computer agent\n  nexowire relay   Start a first-party native-agent relay
  nexowire tailscale [status|serve|funnel|reset]  Manage Tailscale exposure\n  nexowire hub [preflight|install|status|start|stop|restart|uninstall]  Manage user-logon Hub autostart\n  nexowire hub [boot-install|boot-status|boot-uninstall]  Manage elevated pre-logon SYSTEM Hub\n  nexowire node [bootstrap|status|connector]  Bootstrap a self-hosted Hub + local Agent\n  nexowire local-first ingress [--listen-port=43111] [--public-host=host.example.com]
  nexowire local-first funnel-plan               Inspect Tailscale safely; no route changes\n                   LOOPBACK MCP-only origin for a secure tunnel (opt-in)\n  nexowire connect                             Connect this PC to Nexowire\n  nexowire privileged-broker [run|install|status|probe|start|stop|uninstall]\n                              Run or manage the elevated Windows broker\n  nexowire credentials <list|issue|revoke>  Manage hash-only revocable credentials
  nexowire secrets <purposes|inspect|seal>   Manage protected bootstrap secret sources
  nexowire doctor [--remote]                  Evaluate deployment readiness without printing secrets
  nexowire onboard [plan|bootstrap] [...]      Guide a secret-safe local/remote deployment bootstrap
  nexowire update [status|check|apply]   Check or apply verified official releases
  nexowire update auto [install|run|status|enable|disable|uninstall]
                   Manage the lightweight hourly Windows auto-updater
  nexowire local-first cloudflare-run <absolute-profile.json>
                   Run Cloudflare-only MCP ingress (no Tailscale or VPS)
  nexowire version Show the installed Nexowire version
  nexowire help    Show this help

Default HTTP endpoint: http://127.0.0.1:43110/mcp
Default agent endpoint: ws://127.0.0.1:43110/agent
`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'http';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (
    command === 'version' ||
    command === '--version' ||
    command === '-v'
  ) {
    process.stdout.write(NEXOWIRE_VERSION + '\n');
    return;
  }

  if (command === 'connect') {
    await runConnectCommand(process.argv.slice(3));
    return;
  }

  if (command === 'update') {
    if (process.argv[3] === 'auto') {
      await runAutoUpdateCommand(process.argv.slice(4));
    } else {
      await runLiveUpdateCommand(process.argv.slice(3));
    }
    return;
  }

  if (command === 'agent') {
    const action = process.argv[3] ?? 'run';
    if (action === 'run') {
      await runNativeAgent();
    } else if (
      action === 'enroll' ||
      action === 'doctor' ||
      action === 'status'
    ) {
      await runNativeAgentEnrollmentCommand(
        process.argv.slice(3),
      );
    } else {
      await runNativeAgentLifecycleCommand(
        process.argv.slice(3),
      );
    }
    return;
  }

  if (command === 'local-first') {
    if (process.argv[3] === 'cloudflare-run') {
      if(process.argv.length!==5)throw new Error('cloudflare-run requires one absolute profile JSON path');
      await runCloudflareConnection(process.argv[4]!,loadConfig());
      return;
    }
    if (process.argv[3] === 'funnel-plan') {
      if (process.argv.length !== 4) throw new Error('funnel-plan accepts no options');
      process.stdout.write(JSON.stringify(await readOnlyLocalFirstFunnelPlan(),null,2)+'\n');
      return;
    }
    if (process.argv[3] !== 'ingress') {
      throw new Error('local-first supports only: ingress');
    }
    let listenPort = 43111;
    let publicHostname: string | undefined;
    for (const arg of process.argv.slice(4)) {
      if (arg.startsWith('--listen-port=')) {
        const raw = arg.slice('--listen-port='.length);
        if (!/^\d{1,5}$/.test(raw)) throw new Error('Invalid listen port');
        listenPort = Number(raw);
      } else if (arg.startsWith('--public-host=')) {
        publicHostname = arg.slice('--public-host='.length);
      } else {
        throw new Error('Unknown local-first ingress option');
      }
    }
    const config = loadConfig();
    if (publicHostname) {
      const configured = config.mcpResourceUrl
        ? new URL(config.mcpResourceUrl).hostname.toLowerCase() : null;
      if (configured !== publicHostname.toLowerCase() ||
          !config.controlPlaneAgentAuth || !config.mcpResourceUrl) {
        throw new Error('Public local-first ingress requires matching OAuth resource and trusted hosted auth + metering; no quota bypass');
      }
      await verifyLocalFirstPublicUpstream({hubPort:config.port,
        expectedResourceUrl:config.mcpResourceUrl});
    }
    await runLocalFirstIngress({
      hubPort: config.port,listenPort,
      ...(publicHostname ? {publicHostname} : {}),
    });
    return;
  }

  if (command === 'relay') {
    await runRelayServer(loadRelayConfig());
    return;
  }

  if (command === 'tailscale') {
    await runTailscaleCommand(
      loadConfig(),
      process.argv.slice(3),
    );
    return;
  }

  if (command === 'hub') {
    const action = process.argv[3] ?? 'status';
    if (
      action === 'boot-install' ||
      action === 'boot-status' ||
      action === 'boot-uninstall'
    ) {
      await runHubBootLifecycleCommand(
        process.argv.slice(3),
      );
    } else {
      await runHubLifecycleCommand(
        process.argv.slice(3),
      );
    }
    return;
  }

  if (command === 'node') {
    const args = process.argv.slice(3);
    const action = args[0] ?? 'status';
    if (action === 'connector') {
      process.stdout.write(
        JSON.stringify(
          await selfHostedConnectorInfo(),
          null,
          2,
        ) + '\n',
      );
      return;
    }
    await runSelfHostedNodeCommand(
      loadConfig(),
      args,
    );
    return;
  }

  if (command === 'privileged-broker') {
    const action = process.argv[3] ?? 'run';
    if (action === 'run') {
      await runPrivilegedBroker();
    } else {
      await runPrivilegedBrokerLifecycleCommand(
        process.argv.slice(3),
      );
    }
    return;
  }

  if (command === 'credentials') {
    await runCredentialCommand(
      loadConfig(),
      process.argv.slice(3),
    );
    return;
  }

  if (command === 'secrets') {
    await runProtectedSecretCommand(
      process.argv.slice(3),
    );
    return;
  }

  if (command === 'onboard') {
    await runDeploymentOnboardingCommand(
      loadConfig(),
      process.argv.slice(3),
    );
    return;
  }

  if (command === 'doctor') {
    const flags = new Set(process.argv.slice(3));
    for (const flag of flags) {
      if (flag !== '--remote') {
        throw new Error('Unknown doctor option: ' + flag);
      }
    }

    const config = loadConfig();
    const credentials = new CredentialStore(config.stateDir);
    await credentials.initialize();
    const report = await evaluateDeploymentReadiness(config, {
      credentials,
      env: process.env,
      requireRemote: flags.has('--remote'),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (
      !report.ready ||
      (flags.has('--remote') && !report.remoteReady)
    ) {
      process.exitCode = 2;
    }
    return;
  }

  if (command === 'process-worker') {
    const sessionDir = process.argv[3];
    if (!sessionDir) {
      throw new Error('process-worker requires a session directory.');
    }
    if(process.argv[4]!==undefined && process.argv[4]!=='--init-file'){
      throw new Error('process-worker received an unsupported init mode.');
    }
    await runProcessWorker(sessionDir,process.argv[4]==='--init-file');
    return;
  }

  const config = loadConfig();
  const runtime = await createRuntime(config);

  if (command === 'stdio') {
    await runStdioServer(runtime.context);
    return;
  }

  if (command === 'http') {
    await runHttpServer(config, runtime.broker, runtime.context);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(
    `Nexowire fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
