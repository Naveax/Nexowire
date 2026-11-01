// Offline source-level HTML document metadata lint. No DOM/browser or network.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PAGES = ['web/index.html', 'web/connect.html',
  'web/admin.html', 'web/custom-usage-consent-preview.html'];

function attrs(tag) {
  const result = {};
  const value = tag.replace(/^<\s*[a-z]+/i, '').replace(/\/?>$/, '');
  for (const match of value.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

export function auditPageMeta(html) {
  const findings = [];
  // Ignore examples in comments and script/style source, not rendered nodes.
  const source = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const htmlTags = [...source.matchAll(/<html\b[^>]*>/gi)];
  if (htmlTags.length !== 1) findings.push('html-element-count');
  const lang = htmlTags.length === 1 ? attrs(htmlTags[0][0]).lang : null;
  if (!lang || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(lang)) findings.push('missing-or-invalid-lang');

  const head = source.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1];
  if (head === undefined) return [...findings, 'missing-head'];
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)];
  if (titles.length !== 1 || !titles[0][1].replace(/<[^>]+>/g, '').trim()) findings.push('missing-or-duplicate-title');

  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((match) => attrs(match[0]));
  if (metas.filter((meta) => meta.charset?.toLowerCase() === 'utf-8').length !== 1 ||
      metas.some((meta) => meta.charset && meta.charset.toLowerCase() !== 'utf-8')) {
    findings.push('missing-or-duplicate-utf8');
  }
  const viewport = metas.filter((meta) => meta.name?.toLowerCase() === 'viewport');
  if (viewport.length !== 1 || !/\bwidth\s*=\s*device-width\b/i.test(viewport[0]?.content ?? '')) {
    findings.push('missing-or-duplicate-viewport');
  }
  for (const item of viewport) {
    const content = item.content ?? '';
    if (/\buser-scalable\s*=\s*(?:no|0)\b/i.test(content) ||
        [...content.matchAll(/\bmaximum-scale\s*=\s*([\d.]+)/gi)]
          .some((match) => !Number.isFinite(Number(match[1])) || Number(match[1]) < 2)) {
      findings.push('zoom-restricted');
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let total = 0;
  for (const page of process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PAGES) {
    const findings = auditPageMeta(readFileSync(resolve(page), 'utf8'));
    console.log(`${page}: ${findings.length ? findings.join(', ') : 'STATIC PASS'}`);
    total += findings.length;
  }
  console.log('Document metadata source only. Language correctness, zoom rendering and mobile layout: NOT_RUN');
  if (total) process.exitCode = 1;
}
