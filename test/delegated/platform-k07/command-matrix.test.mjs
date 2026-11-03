import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const matrixFile = 'test/delegated/platform-k07/command-matrix.json';

function hasWin32Guard(source) {
  const bootstrap = source.slice(source.indexOf('export async function bootstrapSelfHostedNode('));
  return /if\s*\(process\.platform\s*!==\s*'win32'\)\s*\{\s*throw new Error/s.test(bootstrap);
}

test('developer commands have unique, non-claiming platform classifications', async () => {
  const matrix = JSON.parse(await read(matrixFile));
  assert.match(matrix.status, /source-static-only/);
  const commands = new Set();
  const allowed = new Set([
    'declared-not-executed', 'routed-not-executed',
    'win32-only-not-executed', 'explicitly-rejected',
  ]);
  for (const entry of matrix.commands) {
    assert.ok(!commands.has(entry.command), `Duplicate command: ${entry.command}`);
    commands.add(entry.command);
    assert.ok(allowed.has(entry.windows), `Unvalidated Windows status: ${entry.command}`);
    assert.ok(allowed.has(entry.linux), `Unvalidated Linux status: ${entry.command}`);
    assert.ok(['package.json', 'src/cli.ts', 'src/self-host-bootstrap.ts'].includes(entry.source));
    assert.doesNotMatch(entry.command, /(?:--force|credential|token|secret|install|start|stop|reset)/i);
  }
  assert.ok(commands.size >= 6);
});

test('Node requirement and build script are source-backed', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.scripts.build, 'tsc -p tsconfig.json');
  assert.ok(pkg.bin.nexowire.includes('dist/src/cli.js'));
});

test('CLI actually routes the sampled commands but static routing is not execution', async () => {
  const cli = await read('src/cli.ts');
  for (const branch of ['help', 'onboard', 'doctor', 'node']) {
    assert.ok(cli.includes(`command === '${branch}'`), `Missing CLI path: ${branch}`);
  }
  assert.match(cli, /if \(flag !== '--remote'\)/);
});

test('Linux node bootstrap remains explicitly blocked by platform guard', async () => {
  const code = await read('src/self-host-bootstrap.ts');
  const matrix = JSON.parse(await read(matrixFile));
  const item = matrix.commands.find(({ command }) => command.endsWith('node bootstrap'));
  assert.equal(item.windows, 'win32-only-not-executed');
  assert.equal(item.linux, 'explicitly-rejected');
  assert.equal(hasWin32Guard(code), true);
  assert.equal(hasWin32Guard(code.replace("if (process.platform !== 'win32')", 'if (false)')), false);
  assert.match(await read('docs/SELF_HOST.md'), /rejects non-Windows platforms/);
});
