#!/usr/bin/env node
import { runNativeAgent } from './agent/native-agent.js';
import { loadConfig } from './config.js';
import { runHttpServer } from './mcp/http.js';
import { runStdioServer } from './mcp/stdio.js';
import { createRuntime } from './runtime.js';

function printHelp(): void {
  process.stdout.write(`
Nexowire 0.1.0-dev.1

Usage:
  nexowire http    Start the MCP hub and native-agent WebSocket endpoint
  nexowire stdio   Start an MCP server over stdio
  nexowire agent   Start the native computer agent
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

  const config = loadConfig();
  const runtime = createRuntime(config);

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
