#!/usr/bin/env node
import { runNativeAgent } from './agent/native-agent.js';
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

function printHelp(): void {
  process.stdout.write(`
Nexowire 0.1.0-dev.1

Usage:
  nexowire http    Start the MCP hub and native-agent WebSocket endpoint
  nexowire stdio   Start an MCP server over stdio
  nexowire agent   Start the native computer agent
  nexowire relay   Start a first-party native-agent relay
  nexowire privileged-broker [run|install|status|start|stop|uninstall]\n                              Run or manage the elevated Windows broker\n  nexowire credentials <list|issue|revoke>  Manage hash-only revocable credentials
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

  if (command === 'agent') {
    await runNativeAgent();
    return;
  }

  if (command === 'relay') {
    await runRelayServer(loadRelayConfig());
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
