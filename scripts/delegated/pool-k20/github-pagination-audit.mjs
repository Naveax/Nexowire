#!/usr/bin/env node
/** Offline pagination evidence checker. Never fetches GitHub or claims live completion. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function relPage(header, rel) {
  if (!header) return null;
  const links = header.split(',').map(x => x.trim());
  const matches = links.filter(x => new RegExp(`rel=["']?${rel}["']?(?:;|$)`).test(x));
  if (matches.length > 1) throw new TypeError(`Repeated ${rel} Link relation`);
  if (!matches.length) return null;
  const match = matches[0].match(/^<([^>]+)>/);
  if (!match) throw new TypeError(`Malformed ${rel} Link URL`);
  const url = new URL(match[1]);
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') throw new TypeError('Non-GitHub pagination Link URL');
  const page = Number(url.searchParams.get('page'));
  if (!Number.isSafeInteger(page) || page < 1) throw new TypeError('Invalid Link page number');
  return page;
}

const result = (status, detail, pages = 0, uniqueItems = 0) => ({
  status, detail, pages, uniqueItems, liveVerified: false,
});

export function auditPagination(snapshot) {
  if (!Array.isArray(snapshot?.pages) || !snapshot.pages.length || snapshot.pages.length > 500) {
    throw new TypeError('Expected 1–500 captured page records');
  }
  if (snapshot.incompleteResults === true || snapshot.truncated === true) {
    return result('TRUNCATED', 'Source marked incomplete/truncated');
  }
  const seen = new Set();
  let priorNext = null;
  for (const [i, page] of snapshot.pages.entries()) {
    const n = i + 1;
    if (page.page !== n || (i && priorNext !== n)) return result('GAP', `Missing/out-of-order page ${n}`, i, seen.size);
    if (page.httpStatus !== 200) return result('BLOCKED', `HTTP ${page.httpStatus ?? 'UNKNOWN'} on page ${n}`, i, seen.size);
    if (!Number.isSafeInteger(page.perPage) || page.perPage < 1 || page.perPage > 100 || !Array.isArray(page.items)) {
      return result('UNKNOWN', `Invalid page size/items on page ${n}`, i, seen.size);
    }
    if (page.items.length > page.perPage) return result('TRUNCATED', `Page ${n} exceeds perPage`, i, seen.size);
    if (page.link !== null && page.link !== undefined && typeof page.link !== 'string') {
      return result('UNKNOWN', `Unusable Link header on page ${n}`, i, seen.size);
    }
    let next, last;
    try { next = relPage(page.link, 'next'); last = relPage(page.link, 'last'); }
    catch (e) { return result('UNKNOWN', e.message, i, seen.size); }
    if (next && next !== n + 1) return result('GAP', `Link next points to ${next}, expected ${n + 1}`, i + 1, seen.size);
    if (last && last < n) return result('UNKNOWN', `Invalid last-page Link ${last}`, i + 1, seen.size);
    for (const item of page.items) {
      const key = item?.number ?? item?.id;
      if ((typeof key !== 'string' && !Number.isSafeInteger(key)) || key === '') {
        return result('UNKNOWN', `Unidentifiable item on page ${n}`, i + 1, seen.size);
      }
      if (seen.has(String(key))) return result('GAP', `Repeated item across pages: ${key}`, i + 1, seen.size);
      seen.add(String(key));
    }
    if (i === snapshot.pages.length - 1) {
      if (next) return result('GAP', `Uncollected page ${next}`, i + 1, seen.size);
      if (last && last > n) return result('GAP', `Last advertised page ${last} not collected`, i + 1, seen.size);
      if (page.items.length === page.perPage) {
        return result('UNKNOWN', 'Full final page without next is ambiguous; collect explicit end evidence', i + 1, seen.size);
      }
    }
    priorNext = next;
  }
  if (Number.isSafeInteger(snapshot.totalCount) && snapshot.totalCount > seen.size) {
    return result('TRUNCATED', `Captured ${seen.size} of declared ${snapshot.totalCount}`, snapshot.pages.length, seen.size);
  }
  return result('SNAPSHOT_CONSISTENT_NOT_LIVE_VERIFIED',
    'Consecutive pages and partial final page; source authenticity and current state NOT_RUN', snapshot.pages.length, seen.size);
}

function main() {
  if (process.argv[2] !== '--input' || !process.argv[3] || process.argv.length !== 4) {
    throw new Error('Usage: node github-pagination-audit.mjs --input captured-pages.json');
  }
  const verdict = auditPagination(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  console.log(JSON.stringify(verdict, null, 2));
  if (verdict.status !== 'SNAPSHOT_CONSISTENT_NOT_LIVE_VERIFIED') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`K20 pagination: ${e.message}`); process.exitCode = 2; }
}
