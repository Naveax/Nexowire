import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLinks } from '../../../scripts/delegated/k20/check-doc-links.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'k20-doc-links-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('relative docs and heading links are checked, external links skipped', () => fixture(root => {
  mkdirSync(join(root, 'docs'));
  const source = join(root, 'README.md');
  writeFileSync(source, '[ok](docs/a.md#hello-world) [bad](docs/a.md#absent) [web](https://example.org/x)');
  writeFileSync(join(root, 'docs/a.md'), '# Hello World\n');
  const found = checkLinks(root, [source]);
  assert.equal(found.checked, 2);
  assert.equal(found.skippedExternal, 1);
  assert.deepEqual(found.findings.map(x => x.problem), ['missing-heading']);
}));

test('missing targets, malformed percent codes and escaping repo are flagged', () => fixture(root => {
  const file = join(root, 'README.md');
  writeFileSync(file, '[none](missing.md) [bad](%XX) [escape](../../../../../../etc/passwd)');
  assert.deepEqual(checkLinks(root, [file]).findings.map(x => x.problem),
    ['missing-target', 'invalid-percent-encoding', 'outside-repository']);
}));

test('fenced code snippets are not mistaken for links; local fragments are checked', () => fixture(root => {
  const file = join(root, 'README.md');
  writeFileSync(file, '# A\n```md\n[bad](missing.md)\n```\n[good](#a)');
  assert.deepEqual(checkLinks(root, [file]).findings, []);
}));

test('symlink escape is rejected even when target exists', () => fixture(root => {
  const file = join(root, 'README.md');
  writeFileSync(file, '[bad](outside)');
  symlinkSync(tmpdir(), join(root, 'outside'));
  assert.equal(checkLinks(root, [file]).findings[0].problem, 'symlink-outside-repository');
}));
