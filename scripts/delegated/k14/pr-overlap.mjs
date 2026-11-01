#!/usr/bin/env node
/** Read-only duplicate-work and cross-PR semantic review *candidates*. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { apiRequester, collectSnapshot } from './integration-report.mjs';

const IGNORE = new Set('a an the for and with of in to on from against read only fix test qa docs ui add improve harden make status review offline scope evidence integration contract report reports'.split(' '));

function titleWords(title = '') {
  return new Set(String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(word => word.length > 2 && !IGNORE.has(word)));
}

export function titleSimilarity(a, b) {
  const aa = titleWords(a), bb = titleWords(b);
  if (!aa.size || !bb.size) return 0;
  const intersect = [...aa].filter(word => bb.has(word)).length;
  // Minimum two uncommon shared words prevents weak one-word matches.
  return intersect < 2 ? 0 : intersect / (aa.size + bb.size - intersect);
}

function tags(pr) {
  const paths = pr.files ?? [];
  const tagged = new Set();
  if (paths.some(path => /(?:s5.*cost|cost.*s5|quota|report-s5-cost)/i.test(path))) tagged.add('S5_COST_OR_QUOTA');
  if (paths.some(path => /(?:s5.*bench|bench-s5|scale-transport|transport-metrics)/i.test(path))) tagged.add('S5_TRANSPORT_MEASURE');
  if (paths.some(path => /(?:INSTALL_WINDOWS|SELF_HOST|DEPLOYMENT_ONBOARDING|CHATGPT_INSTALL_PROMPT|newcomer-|web\/connect\.|S3_TWO_STEP_INSTALL)/i.test(path))) tagged.add('CONNECTION_ONBOARDING');
  if (paths.some(path => /(?:mcp-error|MCP_SURFACE|S4_PLAN_STATES)/i.test(path))) tagged.add('MCP_SURFACE_WORDING');
  if (paths.some(path => /(?:pr-summary|integration-report|pr-evidence|PR_SECURITY_SCOPE_AUDIT|pr-triage)/i.test(path))) tagged.add('PR_EVIDENCE_WORKFLOW');
  if (paths.some(path => /(?:web\/styles\.css)/i.test(path))) tagged.add('SHARED_WEB_CSS');
  if (paths.some(path => /^web\/(?:connect|admin|index)\.html$|^web\/(?:connect|admin|app)\.js$/.test(path))) tagged.add('WEB_SCREENS');
  return tagged;
}

export function analyzePairs(prs) {
  const result = [];
  for (let i = 0; i < prs.length; i++) {
    for (let j = i + 1; j < prs.length; j++) {
      const a = prs[i], b = prs[j];
      const filesA = new Set(a.files ?? []), filesB = new Set(b.files ?? []);
      const samePaths = [...filesA].filter(path => filesB.has(path)).sort();
      const tA = tags(a), tB = tags(b);
      const sharedTopics = [...tA].filter(tag => tB.has(tag) && tag !== 'SHARED_WEB_CSS' && tag !== 'WEB_SCREENS');
      if ((tA.has('SHARED_WEB_CSS') && tB.has('WEB_SCREENS')) ||
          (tB.has('SHARED_WEB_CSS') && tA.has('WEB_SCREENS'))) sharedTopics.push('CSS_SCREEN_CONSUMER');
      const similarity = titleSimilarity(a.title, b.title);
      const possibleDuplicate = similarity >= 0.6;
      if (samePaths.length || sharedTopics.length || possibleDuplicate) {
        result.push({ a: Math.min(a.number, b.number), b: Math.max(a.number, b.number),
          samePaths, sharedTopics: sharedTopics.sort(), possibleDuplicate,
          titleJaccard: Math.round(similarity * 100) / 100,
          evidenceComplete: a.filesComplete === true && b.filesComplete === true });
      }
    }
  }
  return result.sort((x, y) => x.a - y.a || x.b - y.b);
}

export function createOverlapReport(snapshot) {
  if (!Array.isArray(snapshot?.prs)) throw new Error('Expected structured integration snapshot prs array');
  const prs = snapshot.prs.filter(pr => Number.isInteger(pr.number) && Array.isArray(pr.files));
  const pairs = analyzePairs(prs);
  return {
    upstreamSha: snapshot.upstreamSha,
    forkSha: snapshot.forkSha,
    sourcePrCount: prs.length,
    filesAllComplete: prs.every(pr => pr.filesComplete === true),
    samePathPairs: pairs.filter(pair => pair.samePaths.length > 0),
    semanticReviewCandidates: pairs.filter(pair => pair.sharedTopics.length || pair.possibleDuplicate),
    certainty: 'Same-path evidence only; semantic and duplicate detections are conservative review prompts, NOT verified conflict or duplicate issue claims.',
  };
}

export function markdown(report) {
  const lines = [
    '# Cross-PR duplicate-work inventory', '',
    `- PRs inspected: ${report.sourcePrCount}`,
    `- All file lists complete: ${report.filesAllComplete}`,
    `- Same-path pair count: ${report.samePathPairs.length}`,
    `- Semantic review candidate count: ${report.semanticReviewCandidates.length}`,
    `- ${report.certainty}`, '',
    '## Same-path candidates', '',
  ];
  lines.push(...(report.samePathPairs.length ? report.samePathPairs.map(x => `- #${x.a} / #${x.b}: ${x.samePaths.map(p => `\`${p}\``).join(', ')}`) : ['- No overlapping paths observed; this is inconclusive if any file list was incomplete.']));
  lines.push('', '## Semantic / duplicate-work review candidates', '');
  lines.push(...(report.semanticReviewCandidates.length ? report.semanticReviewCandidates.map(x => `- #${x.a} / #${x.b}: ${x.sharedTopics.join(', ') || 'TITLE_SIMILARITY'}${x.possibleDuplicate ? ` (title Jaccard ${x.titleJaccard})` : ''}; unverified`) : ['- None at this threshold.']));
  return `${lines.join('\n')}\n`;
}

async function main(args) {
  const idx = args.indexOf('--offline');
  const snapshot = idx >= 0
    ? JSON.parse(await readFile(args[idx + 1], 'utf8'))
    : await collectSnapshot(apiRequester(), { onlyNumbers: Array.from({ length: 23 }, (_, i) => 1010 + i) });
  const report = createOverlapReport(snapshot);
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : markdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Duplicate-work report failed: ${error.message}`); process.exitCode = 1; });
}
