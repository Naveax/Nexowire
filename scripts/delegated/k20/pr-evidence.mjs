#!/usr/bin/env node
/** Evidence summary generator; blank/missing checks are NOT_RUN, never PASS. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VALID = new Set(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED', 'UNKNOWN']);
const escapeMarkdown = value => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function evidence(input = {}) {
  if (input.tests !== undefined && !Array.isArray(input.tests)) throw new TypeError('tests must be an array');
  const tests = (input.tests || []).map(check => {
    if (typeof check.name !== 'string' || !check.name.trim()) throw new TypeError('Test name required');
    if (check.status !== undefined && !VALID.has(check.status)) throw new TypeError(`Unknown test status: ${check.status}`);
    return { name: check.name, status: check.status || 'NOT_RUN', details: check.details || '—' };
  });
  const sha = input.sha || 'NOT_RECORDED';
  const base = input.base || 'NOT_RECORDED';
  if (sha !== 'NOT_RECORDED' && !/^[\da-f]{40}$/i.test(sha)) throw new TypeError('Expected exact 40-char head SHA');
  if (base !== 'NOT_RECORDED' && !/^[\da-f]{40}$/i.test(base)) throw new TypeError('Expected exact 40-char base SHA');
  const items = tests.length ? tests : [{ name: 'Tests', status: 'NOT_RUN', details: 'No test evidence supplied' }];
  const lines = [
    '## Scope',
    escapeMarkdown(input.scope || 'TO_BE_RECORDED'),
    '', '## Exact revision',
    `- Branch: \`${escapeMarkdown(input.branch || 'NOT_RECORDED')}\``,
    `- HEAD: \`${sha}\``,
    `- Base: \`${base}\``,
    '', '## Verification (per check, do not infer CI success)',
    '| Check | Status | Evidence |', '| --- | --- | --- |',
    ...items.map(x => `| ${escapeMarkdown(x.name)} | ${x.status} | ${escapeMarkdown(x.details)} |`),
    '', '## Outstanding acceptance',
    escapeMarkdown(input.outstanding || 'Browser, Windows/device, real provider and exact-head CI: NOT_RUN unless independently evidenced.'),
    '', '## Security scope',
    escapeMarkdown(input.security || 'No CORE/auth/permissions/billing/release changes claimed; confirm against actual diff.'),
    '',
  ];
  return lines.join('\n');
}

function main() {
  if (process.argv.length > 4 || (process.argv.length > 2 && process.argv[2] !== '--input')) {
    throw new Error('Usage: node pr-evidence.mjs [--input metadata.json]');
  }
  const content = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};
  console.log(evidence(content));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 evidence: ${err.message}`); process.exitCode = 1; }
}
