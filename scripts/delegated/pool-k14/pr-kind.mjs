#!/usr/bin/env node
/** Read-only PR file-type evidence: docs, executable tests, tooling and runtime code. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { collectSnapshot, apiRequester } from '../k14/integration-report.mjs';

const SCRIPT = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|ps1|sh|py)$/i;
const DOCUMENT = /\.(?:md|mdx|txt|rst)$/i;
const DATA = /\.(?:json|ya?ml|csv|html|css|svg|png|webp|jpg|jpeg|snap)$/i;

export function classifyPath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('..')) return 'UNKNOWN';
  if (/^docs\/delegated\/prototypes\/.*\.html$/i.test(path)) return 'PROTOTYPE';
  if (DOCUMENT.test(path)) return 'DOCUMENTATION';
  if (path.startsWith('test/')) {
    if (SCRIPT.test(path)) return 'TEST_CODE';
    if (DATA.test(path)) return 'TEST_FIXTURE';
    return 'UNKNOWN';
  }
  if (path.startsWith('scripts/')) {
    if (/\.test\.[cm]?[jt]s$/i.test(path)) return 'TEST_CODE';
    if (SCRIPT.test(path)) return 'TOOL_CODE';
    if (DATA.test(path)) return 'TOOL_FIXTURE';
    return 'UNKNOWN';
  }
  if ((path.startsWith('src/') || path.startsWith('web/')) && (SCRIPT.test(path) || /\.(?:css|html)$/i.test(path))) return 'RUNTIME_SOURCE';
  if (DATA.test(path)) return 'ASSET_OR_CONFIG';
  return 'UNKNOWN';
}

export function classifyPr(pr) {
  const files = [...new Set(pr?.files ?? [])];
  if (!Number.isSafeInteger(pr?.number) || !Array.isArray(pr?.files)) throw new TypeError('PR number and complete file array are required');
  const categories = {};
  for (const path of files) {
    const kind = classifyPath(path);
    categories[kind] = (categories[kind] ?? 0) + 1;
  }
  const has = kind => Boolean(categories[kind]);
  const allDocs = files.length > 0 && files.every(path => classifyPath(path) === 'DOCUMENTATION');
  const category = !files.length || pr.filesComplete !== true || has('UNKNOWN') ? 'UNVERIFIED_FILE_SCOPE'
    : allDocs ? 'DOC_ONLY'
      : has('RUNTIME_SOURCE') ? 'RUNTIME_SOURCE_PRESENT'
        : has('TOOL_CODE') ? 'TOOLING_PRESENT'
          : has('TEST_CODE') || has('TEST_FIXTURE') ? 'TEST_OR_FIXTURE_ONLY'
            : has('PROTOTYPE') ? 'PROTOTYPE_PRESENT' : 'NON_CODE_ASSETS';
  return {
    number: pr.number, head: pr.head ?? 'UNKNOWN', category, filesComplete: pr.filesComplete === true,
    files: files.length, categories,
    productRuntimeCodeChanged: has('RUNTIME_SOURCE'),
    executableTestChanged: has('TEST_CODE'),
    docsOnly: allDocs && pr.filesComplete === true,
    acceptance: 'NOT_INFERRED: code paths do not prove execution, CI, usability or merge readiness',
  };
}

export function summarizeKinds(snapshot) {
  if (!Array.isArray(snapshot?.prs)) throw new TypeError('Expected snapshot.prs');
  const prs = snapshot.prs.map(classifyPr).sort((a, b) => a.number - b.number);
  const counts = {};
  for (const pr of prs) counts[pr.category] = (counts[pr.category] ?? 0) + 1;
  return { observation: snapshot.observation ?? 'LIVE_READ_ONLY', sourcePrCount: prs.length,
    categoryCounts: counts, prs, evidence: 'File extensions/paths only; no feature or test acceptance claim.' };
}

export function markdown(report) {
  return [
    '# PR content classification (path evidence only)', '',
    `- Scope: ${report.sourcePrCount} PRs`,
    `- Observation: ${report.observation}`,
    `- ${report.evidence}`, '',
    '| PR | Classification | Runtime source | Executable test | Docs only | Files |',
    '| --- | --- | --- | --- | --- | ---: |',
    ...report.prs.map(p => `| #${p.number} | ${p.category} | ${p.productRuntimeCodeChanged ? 'yes' : 'no'} | ${p.executableTestChanged ? 'yes' : 'no'} | ${p.docsOnly ? 'yes' : 'no'} | ${p.files} |`),
    '', 'The presence of code or a test file does **not** mean the code was merged or tested in hosted CI.', '',
  ].join('\n');
}

async function main(args) {
  const idx = args.indexOf('--offline');
  if (idx >= 0 && !args[idx + 1]) throw new Error('--offline path required');
  const snapshot = idx >= 0 ? JSON.parse(await readFile(args[idx + 1], 'utf8'))
    : await collectSnapshot(apiRequester(), { onlyNumbers: Array.from({ length: 23 }, (_, i) => 1010 + i) });
  const result = summarizeKinds(snapshot);
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : markdown(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`PR kind report failed: ${error.message}`); process.exitCode = 1; });
}
