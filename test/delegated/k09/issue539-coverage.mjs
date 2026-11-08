#!/usr/bin/env node
// Read-only issue #539 reliability-roadmap coverage; no issue closure or runtime actions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ISSUE_URL = 'https://github.com/Naveax/Nexowire/issues/539';
export const CANONICAL_PATH = 'docs/NEXOWIRE_CROSS_PROJECT_RELIABILITY_BACKLOG_20261018.md';
export const PINNED_BLOB = '0e786feb00183d2769445562afd2403f559429f6';
export const LANES = Object.freeze({
  R01: 'non-core error-language QA',
  R02: 'protected Agent journal',
  R03: 'protected reconciliation',
  R04: 'protected authorization',
  R05: 'protected file/USB grants',
  R06: 'protected transport/reconnect',
  R07: 'protected process lifecycle',
  R08: 'protected shell execution',
  R09: 'protected GUI/Broker grant',
  R10: 'non-core read-only artifact QA',
  R11: 'non-core Doctor UX QA',
  R12: 'non-core offline scale QA',
  R13: 'non-core provider-error language QA',
  R14: 'protected OAuth compatibility',
  R15: 'protected artifact authority',
  R16: 'protected UIA/file picker',
  R17: 'non-core environment diagnostics QA',
  R18: 'non-core progress-state QA',
  R19: 'protected Agent/Broker lifecycle',
  R20: 'protected idempotent mutation',
  R21: 'non-core physical acceptance plan',
  R22: 'non-core CI/release evidence QA',
});

export function gitBlobSha(text) {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function extractCanonicalItems(text) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const match = /^\|\s*(R\d{2})\s*\|\s*(P\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$/.exec(line);
    return match ? [{ id: match[1], priority: match[2], scope: match[3].trim(), initial: match[4].trim(), exit: match[5].trim(), line: index + 1 }] : [];
  });
}

export function auditCoverage(text, { requirePinned = true } = {}) {
  const errors = [];
  if (requirePinned && gitBlobSha(text) !== PINNED_BLOB) errors.push('Canonical source blob changed; re-read and reclassify before publication');
  const items = extractCanonicalItems(text);
  const expected = Object.keys(LANES);
  const counts = new Map();
  for (const item of items) {
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    if (!expected.includes(item.id)) errors.push(`Unknown issue sub-ID ${item.id}`);
    if (!item.scope || !item.initial || !item.exit) errors.push(`Missing evidence field ${item.id}`);
  }
  for (const id of expected) {
    if (counts.get(id) !== 1) errors.push(`${id} must appear exactly once (observed ${counts.get(id) ?? 0})`);
  }
  return { errors, items };
}

export function renderCoverage(text, meta) {
  const { errors, items } = auditCoverage(text);
  assert.deepEqual(errors, [], `Issue coverage input invalid: ${errors.join('; ')}`);
  if (!/^[0-9a-f]{40}$/.test(meta?.mainSha ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(meta?.date ?? '')) {
    throw new TypeError('Specify observed exact main SHA and date');
  }
  const lines = [
    `# Issue #539 — 22-of-22 roadmap coverage (${meta.date})`,
    '',
    `Source: ${ISSUE_URL} and \`${CANONICAL_PATH}\` blob \`${PINNED_BLOB}\`; observed main \`${meta.mainSha}\`.`,
    'This is a scope inventory, **not proof of any fix, CI success, or physical acceptance**.',
    '',
    '| ID | Priority | Safe owner lane | Existing canonical roadmap line | Closure |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of items.sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`| ${row.id} | ${row.priority} | ${LANES[row.id]} | ${row.line} | NOT_VERIFIED |`);
  }
  lines.push('', 'All 22 issue checkboxes remain independently gated by source, exact-HEAD CI, staging, production/device acceptance, and original incident reproduction. Protected lanes require the designated owner; non-core lanes are only documentation/test opportunities.');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const content = readFileSync(resolve(root, CANONICAL_PATH), 'utf8');
    process.stdout.write(renderCoverage(content, { mainSha: '4e7db16f4233048a956664bef6b607781eb63fb7', date: '2026-11-07' }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid coverage data');
    process.exitCode = 2;
  }
}
