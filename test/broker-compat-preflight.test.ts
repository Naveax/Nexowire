import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const script = resolve('scripts/diagnose-broker-compat.ps1');

test('Broker preflight is read-only and does not manipulate tasks, services, or tokens', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /\.Proxy = \$null/);
  assert.match(source, /Get-NetTCPConnection/);
  assert.match(source, /Get-ScheduledTask/);
  assert.match(source, /ConvertTo-Json/);
  for (const forbidden of [
    'Stop-Process', 'Start-Process', 'Restart-Service', 'Stop-Service',
    'Start-ScheduledTask', 'Stop-ScheduledTask', 'Set-ScheduledTask',
    'Invoke-Expression', 'Remove-Item',
  ]) {
    assert.ok(!source.includes(forbidden), `Unexpected mutating command: ${forbidden}`);
  }
  assert.doesNotMatch(source, /Get-Content[^\n]*?(token|secret|credential)/i);
});

async function withBrokerFixture(
  status: 401 | 404,
  healthRoute: boolean,
  runTest: (report: Record<string, unknown>) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'nexowire-broker-preflight-'));
  const brokerFile = join(root, 'dist', 'src', 'agent', 'privileged-broker.js');
  await mkdir(join(root, 'dist', 'src', 'agent'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'nexowire', version: healthRoute ? '1.0.5' : '1.0.0',
  }));
  await writeFile(brokerFile, healthRoute ? "request.url === '/health'" : "request.url === '/execute'");
  const server: Server = createServer((_req, response) => {
    response.writeHead(status, {'content-type':'application/json'});
    response.end(JSON.stringify({ok:false,error:{code:status === 401 ? 'UNAUTHORIZED' : 'NOT_FOUND'}}));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const {stdout} = await run('powershell.exe', [
      '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',script,'-Port',String(addr.port),'-StackPackageRoot',root,
    ], {timeout:20000, maxBuffer:8192});
    runTest(JSON.parse(stdout) as Record<string, unknown>);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, {recursive:true,force:true});
  }
}

test('Broker preflight detects a legacy /health mismatch without accessing any secret', {
  skip:process.platform !== 'win32',
}, async () => {
  await withBrokerFixture(404, false, report => {
    assert.equal(report.classification, 'LEGACY_STACK_BROKER_INCOMPATIBLE');
    assert.equal(report.unauthenticatedHealthStatus, 404);
    assert.equal(report.stackPackageVersion, '1.0.0');
    assert.equal(report.stackCodeHasHealthRoute, false);
    assert.equal(report.privilegedHealthVerified, false);
  });
});

test('HTTP 401 confirms only route compatibility, not elevated Broker permission', {
  skip:process.platform !== 'win32',
}, async () => {
  await withBrokerFixture(401, true, report => {
    assert.equal(report.classification, 'ROUTE_COMPATIBLE_AUTH_REQUIRED');
    assert.equal(report.unauthenticatedHealthStatus, 401);
    assert.equal(report.stackCodeHasHealthRoute, true);
    assert.equal(report.privilegedHealthVerified, false);
  });
});
