#!/usr/bin/env node
/** Render scenario inventory without implying draft PRs were merged or deployed. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const markdownSafe = text => text.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');

export function renderCatalog(scenarios) {
  if (!Array.isArray(scenarios)) throw new TypeError('Expected scenario array');
  const seen = new Set();
  const lines = [
    '# Non-core user-scenario regression catalog', '',
    'Draft work is **not merged, released or accepted**. A scenario is delivered only with a verified merge SHA and test evidence.',
    '', '| ID | User scenario | Source PR | Status | Local proof / acceptance |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const scenario of [...scenarios].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!/^NC-\d{3}$/.test(scenario.id) || seen.has(scenario.id)) throw new TypeError('Duplicate or invalid scenario ID');
    seen.add(scenario.id);
    if (![ 'DRAFT', 'MERGED_VERIFIED' ].includes(scenario.status)) throw new TypeError('Invalid merge status');
    if (typeof scenario.description !== 'string' || !scenario.description.trim()) throw new TypeError('Missing description');
    if (!/^https:\/\/github\.com\/Naveax\/Nexowire\/pull\/\d+$/.test(scenario.pr)) throw new TypeError('Invalid PR URL');
    const merged = scenario.status === 'MERGED_VERIFIED';
    if (merged && (!/^[a-f\d]{40}$/i.test(scenario.mergeSha || '') || !scenario.evidence)) {
      throw new TypeError('Merged state requires exact SHA and nonempty evidence');
    }
    if (!merged && scenario.mergeSha) throw new TypeError('Draft cannot claim a merge SHA');
    lines.push(`| ${scenario.id} | ${markdownSafe(scenario.description)} | [#${scenario.pr.split('/').at(-1)}](${scenario.pr}) | ` +
      `${scenario.status} | ${markdownSafe(scenario.evidence || 'NOT_RUN for release/real-device acceptance')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  if (process.argv.length > 3) throw new Error('Usage: node regression-catalog.mjs [scenarios.json]');
  const input = process.argv[2] || 'docs/delegated/maintenance-k20/scenarios.json';
  console.log(renderCatalog(JSON.parse(readFileSync(input, 'utf8'))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 regression: ${err.message}`); process.exitCode = 1; }
}
