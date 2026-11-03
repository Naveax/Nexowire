#!/usr/bin/env node
/** Supplemental risk mapping for NC-xxx scenarios, no release acceptance implied. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function renderRiskOverlay(records) {
  if (!Array.isArray(records)) throw new TypeError('Expected risk array');
  const ids = new Set();
  const lines = ['# Non-core regression scenario risk overlay', '',
    'All entries are **NOT_RUN** for actual user/device acceptance until independently verified.', '',
    '| Scenario | Regression risk | Failure to prevent | Acceptance evidence | Status |',
    '| --- | --- | --- | --- | --- |'];
  for (const item of [...records].sort((a,b)=>a.id.localeCompare(b.id))) {
    if (!/^NC-\d{3}$/.test(item?.id || '') || ids.has(item.id)) throw new TypeError('Invalid/duplicate scenario ID');
    ids.add(item.id);
    for (const key of ['risk', 'negativeCase', 'evidenceNeeded']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) throw new TypeError(`Missing ${key}`);
    }
    if (item.acceptance !== 'NOT_RUN') throw new TypeError('Evidence required before any acceptance status change');
    const safe = s => s.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
    lines.push(`| ${item.id} | ${safe(item.risk)} | ${safe(item.negativeCase)} | ${safe(item.evidenceNeeded)} | NOT_RUN |`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const source = process.argv[2] || 'docs/delegated/maintenance-k20/scenario-risk-overlay.json';
  if (process.argv.length > 3) throw new Error('Usage: scenario-risk-audit.mjs [overlay.json]');
  process.stdout.write(renderRiskOverlay(JSON.parse(readFileSync(source, 'utf8'))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 risk: ${err.message}`); process.exitCode = 2; }
}
