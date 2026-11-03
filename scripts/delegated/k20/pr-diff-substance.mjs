#!/usr/bin/env node
/** Classifies changed-file scope only. Never equates documentation with no value. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function classifyPrFiles(snapshot) {
  if (!/^[a-f\d]{40}$/i.test(snapshot?.headSha || '')) throw new TypeError('Exact HEAD SHA required');
  if (snapshot.filesComplete !== true || !Array.isArray(snapshot.files)) {
    return { headSha: snapshot.headSha, kind: 'UNKNOWN', reason: 'Incomplete or absent PR file list' };
  }
  const paths = snapshot.files.map(x => typeof x === 'string' ? x : x?.filename);
  if (paths.some(x => typeof x !== 'string' || !x || x.startsWith('/') || x.includes('..'))) {
    throw new TypeError('Malformed changed-file path');
  }
  if (!paths.length) return { headSha: snapshot.headSha, kind: 'EMPTY_DIFF', changedFiles: 0 };
  const reportOnly = paths.every(p => p.startsWith('ekip/'));
  const docsOnly = paths.every(p => p.startsWith('docs/') || /^(README|ROADMAP|HANDOFF)\.md$/.test(p));
  const testOnly = paths.every(p => p.startsWith('test/'));
  const kind = reportOnly ? 'TEAM_REPORT_ONLY' : docsOnly ? 'DOCS_ONLY' : testOnly ? 'TEST_ONLY' : 'CODE_OR_MIXED';
  return { headSha: snapshot.headSha, kind, changedFiles: paths.length,
    note: 'File-scope classification only; cannot judge semantic implementation or merge readiness' };
}

function main() {
  if (process.argv[2] !== '--input' || !process.argv[3] || process.argv.length !== 4) {
    throw new Error('Usage: node pr-diff-substance.mjs --input pr-files-snapshot.json');
  }
  console.log(JSON.stringify(classifyPrFiles(JSON.parse(readFileSync(process.argv[3], 'utf8'))), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 scope: ${err.message}`); process.exitCode = 2; }
}
