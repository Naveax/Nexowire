import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

/**
 * #46 RED source acceptance against the REAL, currently UNCONFINED shell.exec.
 * Everything read/written/listened to is generated below os.tmpdir(). This
 * is NOT an OS task sandbox or a native low-token/AppContainer attestation.
 * Never convert these negatives to mocks, skips, or successful sandbox proof.
 * The separate #786/#800 assertion files remain byte-identical/untouched.
 */
const PREFIX = 'NW46_PROBE:';
const PROBE = String.raw`
'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const net = require('node:net');
const dgram = require('node:dgram');
const [mode, encoded] = process.argv.slice(2);
const v = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
const report = (value) => console.log('NW46_PROBE:' + JSON.stringify(value));
(async () => {
  if (mode === 'outside-file') {
    const marker = fs.readFileSync(v.outside, 'utf8');
    fs.writeFileSync(v.canary, marker);
    return report({ touched: true });
  }
  if (mode === 'env') {
    return report({ inherited: process.env[v.key] === v.value });
  }
  if (mode === 'child') {
    const code = 'require("node:fs").writeFileSync(' + JSON.stringify(v.canary) + ',"CHILD_ESCAPED")';
    const child = cp.spawnSync(process.execPath, ['-e', code], { windowsHide: true, timeout: 4000 });
    return report({ spawned: !child.error, code: child.status });
  }
  if (mode === 'link') {
    const marker = fs.readFileSync(v.link, 'utf8');
    fs.writeFileSync(v.canary, marker);
    return report({ touched: true });
  }
  if (mode === 'hardlink') {
    fs.writeFileSync(v.link, 'MODIFIED_VIA_HARDLINK');
    return report({ touched: true });
  }
  if (mode === 'network') {
    await Promise.all([
      new Promise((done) => {
        const sock = net.connect({ host: '127.0.0.1', port: v.tcp });
        sock.setTimeout(1500, () => { sock.destroy(); done(); });
        sock.once('connect', () => { sock.destroy(); done(); });
        sock.once('error', () => done());
      }),
      new Promise((done) => {
        const sock = dgram.createSocket('udp4');
        sock.send(Buffer.from('NW46_UDP'), v.udp, '127.0.0.1', () => { sock.close(); done(); });
        sock.once('error', () => { sock.close(); done(); });
      }),
      new Promise((done) => {
        // One syntactically valid A DNS question over a LOCAL UDP socket.
        // No public resolver, hostname, or internet service is contacted.
        const header = Buffer.from('46ab01000001000000000000', 'hex');
        const question = Buffer.from('046e77343607696e76616c69640000010001', 'hex');
        const sock = dgram.createSocket('udp4');
        sock.send(Buffer.concat([header, question]), v.dns, '127.0.0.1', () => { sock.close(); done(); });
        sock.once('error', () => { sock.close(); done(); });
      }),
    ]);
    return report({ probeCompleted: true });
  }
  if (mode === 'orphan') {
    // Grandchild remains after root timeout unless the real executor
    // terminates the entire OS process tree / job, including descendants.
    const code = 'setTimeout(()=>{require("node:fs").writeFileSync(' +
      JSON.stringify(v.canary) + ',"ORPHAN_SURVIVED")},1300)';
    const child = cp.spawn(process.execPath, ['-e', code], {
      detached: false, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    await new Promise(resolve => setTimeout(resolve, 8000));
    return report({ unexpectedlyReturned: true });
  }
  throw new Error('UNKNOWN_QA46_MODE');
})().catch(error => { report({ error: String(error.code || error.message) }); process.exitCode = 3; });
`;

type ShellResult = { stdout: string; stderr: string; exitCode: number | null; data?: { timedOut?: boolean } };
function quote(s: string): string {
  // Fixture paths originate under OS TEMP; reject unusual shell metacharacters
  // rather than generating a command with unexpectedly expanded input.
  assert.doesNotMatch(s, /[\r\n"%!^&|<>]/u, 'BLOCKED: unsafe fixture command path');
  return process.platform === 'win32' ? '"' + s + '"' : "'" + s.replaceAll("'", "'\\''") + "'";
}
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  assert.ok(process.platform === 'win32' || process.platform === 'linux',
    'BLOCKED: #46 source negative is explicitly Windows/Linux only');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-p46-native-red-'));
  t.after(async () => { await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const allowed = path.join(temp, 'allowed');
  const outside = path.join(temp, 'outside');
  const helper = path.join(allowed, 'qa46-probe.cjs');
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.writeFile(helper, PROBE, 'utf8');
  return { temp, allowed, outside, helper, policy: new PathPolicy([allowed]) };
}
async function probe(
  scope: Awaited<ReturnType<typeof fixture>>, mode: string, parameters: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<ShellResult> {
  const data = Buffer.from(JSON.stringify(parameters), 'utf8').toString('base64url');
  const command = [process.execPath, scope.helper, mode, data].map(quote).join(' ');
  const raw = await executeCapability('shell.exec', {
    command, cwd: scope.allowed, shell: process.platform === 'win32' ? 'cmd' : 'sh',
    ui_target: 'headless', timeout_ms: timeoutMs, max_output_bytes: 16384,
  }, scope.policy);
  return raw as ShellResult;
}
function requireExecuted(result: ShellResult): Record<string, unknown> {
  const line = result.stdout.split(/\r?\n/u).find(v => v.startsWith(PREFIX));
  assert.ok(line, 'BLOCKED: source probe did not return an attributable OS result; do not call it sandbox PASS');
  return JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
}
async function exists(file: string): Promise<boolean> {
  return await fs.stat(file).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return false;
    throw e;
  });
}

test('#46 RED: shell.exec cwd/PathPolicy cannot authorize outside TEMP file read/write', {timeout: 25_000}, async t => {
  const s = await fixture(t);
  const secret = path.join(s.outside, 'only-disposable-marker.txt');
  const canary = path.join(s.outside, 'shell-canary.txt');
  await fs.writeFile(secret, 'TEMP_NON_SECRET');
  const result = await probe(s, 'outside-file', { outside: secret, canary });
  requireExecuted(result);
  assert.equal(await exists(canary), false, 'OS boundary failed: shell accessed and wrote outside task root');
});

test('#46 RED: child must not inherit synthetic parent secret', {timeout: 25_000}, async t => {
  const s = await fixture(t);
  const key = 'NEXOWIRE_QA46_DISPOSABLE_SECRET';
  const previous = process.env[key];
  const value = randomUUID(); // Synthetic only, never a credential.
  process.env[key] = value;
  try {
    const result = requireExecuted(await probe(s, 'env', { key, value }));
    assert.equal(result.inherited, false, 'OS boundary failed: synthetic environment secret inherited');
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('#46 RED: spawned child must retain OS filesystem restriction', {timeout: 25_000}, async t => {
  const s = await fixture(t);
  const canary = path.join(s.outside, 'child.txt');
  requireExecuted(await probe(s, 'child', { canary }));
  assert.equal(await exists(canary), false, 'OS boundary failed: descendant process escaped task root');
});

test('#46 RED: symlink/JUNCTION reparse target must not escape physical root', {timeout: 25_000}, async t => {
  const s = await fixture(t);
  const target = path.join(s.outside, 'synthetic-marker.txt');
  await fs.writeFile(target, 'LINK_TARGET');
  const link = path.join(s.allowed, 'outside-link');
  try { await fs.symlink(s.outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { assert.fail('BLOCKED: native TEMP symlink/reparse fixture unavailable: ' + String(error)); }
  const canary = path.join(s.outside, 'symlink-canary.txt');
  requireExecuted(await probe(s, 'link', { link: path.join(link, 'synthetic-marker.txt'), canary }));
  assert.equal(await exists(canary), false, 'OS boundary failed: symlink/junction follows outside target');
});

test('#46 RED: same-volume hardlink must not mutate outside task file', {timeout: 25_000}, async t => {
  const s = await fixture(t);
  const original = path.join(s.outside, 'hardlink-original.txt');
  const link = path.join(s.allowed, 'hardlink-alias.txt');
  await fs.writeFile(original, 'ORIGINAL');
  try { await fs.link(original, link); }
  catch (error) { assert.fail('BLOCKED: native TEMP hardlink fixture unavailable: ' + String(error)); }
  requireExecuted(await probe(s, 'hardlink', { link }));
  assert.equal(await fs.readFile(original, 'utf8'), 'ORIGINAL',
    'OS boundary failed: hardlink inside root modified outside file identity');
});

test('#46 RED: Git post-commit helper must retain OS restriction, not just PathPolicy', {timeout: 35_000}, async t => {
  const s = await fixture(t);
  const canary = path.join(s.outside, 'git-child-canary.txt');
  const marker = path.join(s.outside, 'git-hook-source.txt');
  await fs.writeFile(marker, 'DISPOSABLE_GIT_HOOK');
  const hooks = path.join(s.allowed, 'qa46-hooks');
  await fs.mkdir(hooks);
  const hook = path.join(hooks, 'post-commit');
  const encoded = Buffer.from(JSON.stringify({outside: marker, canary})).toString('base64url');
  const hookQuote = (value: string) => '"' + value.replaceAll('\\', '/') + '"';
  await fs.writeFile(hook,
    '#!/bin/sh\n' + [process.execPath, s.helper, 'outside-file', encoded].map(hookQuote).join(' ') + ' >/dev/null\n',
    {mode: 0o755});
  const isolatedGitEnv = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args: string[]) => {
    const r = spawnSync('git', ['-C', s.allowed, ...args], {
      env: isolatedGitEnv, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(r.status, 0, 'BLOCKED: disposable Git hook setup: ' + String(r.error || r.stderr));
  };
  git(['init', '--quiet']);
  const options = [
    '-c', 'core.hooksPath=' + hooks,
    '-c', 'user.name=P46 Disposable QA',
    '-c', 'user.email=p46@example.invalid',
    'commit', '--allow-empty', '--quiet', '-m', 'TEMP QA hook',
  ];
  // Physical witness: the hook REALLY executes without sandbox enforcement.
  // A misconfigured Git installation must not create a misleading green.
  git(options);
  assert.equal(await fs.readFile(canary, 'utf8'), 'DISPOSABLE_GIT_HOOK');
  await fs.unlink(canary);
  const command = ['git', '-C', s.allowed, ...options].map(quote).join(' ');
  const raw = await executeCapability('shell.exec', {
    command, cwd: s.allowed, shell: process.platform === 'win32' ? 'cmd' : 'sh',
    ui_target: 'headless', timeout_ms: 8000, max_output_bytes: 16384,
  }, s.policy) as ShellResult;
  assert.equal(raw.exitCode, 0, 'BLOCKED: cannot attribute an OS sandbox verdict to a rejected/unavailable Git invocation');
  assert.equal(await exists(canary), false,
    'OS boundary failed: Git hook subprocess wrote outside the task root');
});

test('#46 RED: DNS-protocol UDP, TCP, UDP loopback must be blocked by task network policy', {timeout: 25_000}, async t => {
  const s = await fixture(t);
  const hits = { tcp: 0, udp: 0, dns: 0 };
  const tcp = net.createServer(socket => { hits.tcp++; socket.destroy(); });
  const udp = dgram.createSocket('udp4');
  const dns = dgram.createSocket('udp4');
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve));
  t.after(async () => {
    tcp.close(); udp.close(); dns.close();
  });
  udp.on('message', b => { if (b.toString() === 'NW46_UDP') hits.udp++; });
  dns.on('message', b => { if (b.subarray(0, 2).toString('hex') === '46ab') hits.dns++; });
  requireExecuted(await probe(s, 'network', {
    tcp: (tcp.address() as {port: number}).port,
    udp: (udp.address() as {port: number}).port,
    dns: (dns.address() as {port: number}).port,
  }));
  await sleep(250);
  assert.deepEqual(hits, {tcp: 0, udp: 0, dns: 0},
    'OS boundary failed: shell reached only-loopback TCP/UDP or sent DNS wire query');
});

test('#46 RED: timeout must terminate all descendants, not only immediate shell PID', {timeout: 25_000}, async t => {
  const s = await fixture(t);
  const canary = path.join(s.outside, 'orphan-after-timeout.txt');
  const result = await probe(s, 'orphan', {canary}, 400);
  assert.equal(result.data?.timedOut, true, 'BLOCKED: timeout not independently recorded');
  await sleep(2000);
  assert.equal(await exists(canary), false,
    'OS boundary failed: descendant survived root timeout / termination');
});

/**
 * Independent physical acceptance still requires actual launched low-token /
 * AppContainer or Linux namespace token/mount/net isolation evidence, per-task
 * identity, and real OS denial. No assertion above is that evidence.
 * A passing terminate-only case proves cleanup on that run, not sandboxing.
 */
