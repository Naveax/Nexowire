import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditHelpLinks } from '../../../scripts/delegated/k20/help-link-audit.mjs';

function fixture(html, extra = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'k20-help-'));
  const path = join(root, 'page.html');
  try {
    writeFileSync(path, html);
    extra(root);
    return auditHelpLinks(root, [path]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('external and runtime help links explicitly remain NOT_RUN', () => {
  const r = fixture('<a href="https://example.org/help" target="_blank" rel="noopener noreferrer">Yardım</a> <a href="/oauth">Bağlantı bilgisi</a>');
  assert.equal(r.findings.length, 0);
  assert.equal(r.externalNotVerified, 1);
  assert.equal(r.runtimeNotVerified, 1);
  assert.deepEqual(r.links.map(x => x.state), ['NOT_RUN', 'NOT_RUN']);
});

test('unsafe schemes, plaintext remote help and target blank omissions are failures', () => {
  const r = fixture('<a href="javascript:alert(1)">Yardım</a><a href="http://example.com">Rehber</a><a href="https://example.com" target="_blank">Help</a>');
  assert.deepEqual(r.findings.map(x => x.problem), [
    'unsupported-or-unsafe-scheme', 'unsafe-external-url', 'blank-target-without-noopener',
  ]);
});

test('valid local heading passes; missing target and anchor fail', () => {
  const r = fixture('<a href="other.html#good">Yardım</a><a href="other.html#lost">Rehber</a><a href="missing.html">Help</a>',
    root => writeFileSync(join(root, 'other.html'), '<h2 id="good">Hi</h2>'));
  assert.equal(r.links[0].state, 'STATIC_OK');
  assert.deepEqual(r.findings.map(x => x.problem), ['missing-fragment', 'missing-target']);
});

test('symlink outside checkout is not accepted as a local help page', () => {
  const r = fixture('<a href="outside">Yardım</a>', root => symlinkSync(tmpdir(), join(root, 'outside')));
  assert.equal(r.findings[0].problem, 'symlink-outside-repository');
});
