#!/usr/bin/env node
import { runNativeAgent } from './agent/native-agent.js';
import { runConnectCommand } from './connect.js';
import { runNativeAgentLifecycleCommand } from './agent/native-agent-lifecycle.js';
import { runNativeAgentEnrollmentCommand } from './agent/native-agent-enrollment.js';
import { runProcessWorker } from './agent/process-worker.js';
import { loadConfig } from './config.js';
import { runHttpServer } from './mcp/http.js';
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

function printHelp(): void {
  process.stdout.write(`
Nexowire ${NEXOWIRE_VERSION}

Usage:
  nexowire http    Start the MCP hub and native-agent WebSocket endpoint
  nexowire stdio   Start an MCP server over stdio
  nexowire agent [run|enroll|doctor|status|install|start|stop|restart|uninstall]\n                   Enroll, diagnose, run, or manage the native computer agent\n  nexowire relay   Start a first-party native-agent relay
  nexowire tailscale [status|serve|funnel|reset]  Manage Tailscale exposure\n  nexowire hub [install|status|start|stop|restart|uninstall]  Manage user-logon Hub autostart\n  nexowire hub [boot-install|boot-status|boot-uninstall]  Manage elevated pre-logon SYSTEM Hub\n  nexowire node [bootstrap|status|connector]  Bootstrap a self-hosted Hub + local Agent\n  nexowire connect                             Connect this PC to Nexowire\n  nexowire privileged-broker [run|install|status|start|stop|uninstall]\n                              Run or manage the elevated Windows broker\n  nexowire credentials <list|issue|revoke>  Manage hash-only revocable credentials
  nexowire secrets <purposes|inspect|seal>   Manage protected bootstrap secret sources
  nexowire doctor [--remote]                  Evaluate deployment readiness without printing secrets
  nexowire onboard [plan|bootstrap] [...]      Guide a secret-safe local/remote deployment bootstrap
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
    await runLiveUpdateCommand(process.argv.slice(3));
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
    await runProcessWorker(sessionDir);
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
