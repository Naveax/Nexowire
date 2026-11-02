#!/usr/bin/env node
// Offline, read-only candidates for manual review. No release or deployment lookup is implied.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FILES = [
  'README.md',
  'docs/CHATGPT_INSTALL_PROMPT.md',
  'docs/INSTALL_WINDOWS.md',
];

const versionPattern = /\bv?(\d+)\.(\d+)\.(\d+)(?:[-+][a-z0-9.-]+)?\b/gi;
const historic = /(?<![\p{L}\p{N}])(?:historical|archive|archived|legacy|rollback|previous|prior|older|old|önceki|eski|arşiv|tarihsel)(?![\p{L}\p{N}])/iu;
const currentGuide = /(?<![\p{L}\p{N}])(?:current|latest|official|install|installer|download|setup|recommended|use|kurucu|kurulum|indir|yayımlanmış|yeni)(?![\p{L}\p{N}])/iu;

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new TypeError('Release baseline must be an exact vMAJOR.MINOR.PATCH tag');
  const parts = match.slice(1).map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n))) throw new TypeError('Invalid release version');
  return parts;
}

function compareTriplet(left, right) {
  for (let n = 0; n < 3; n++) {
    if (left[n] !== right[n]) return left[n] < right[n] ? -1 : 1;
  }
  return 0;
}

export function inspectFile(path, text, baseline) {
  const reference = parseVersion(baseline);
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(versionPattern)) {
      const version = match[0];
      const triplet = match.slice(1, 4).map(Number);
      if (triplet.some((n) => !Number.isSafeInteger(n))) continue;
      const comparison = compareTriplet(triplet, reference);
      if (comparison === 0) continue;
      const historyContext = historic.test(lines[i]) || historic.test(lines[i - 1] ?? '');
      const classification = comparison > 0
        ? 'FUTURE_VERSION_REVIEW'
        : historyContext ? 'HISTORICAL_CONTEXT' : currentGuide.test(lines[i])
          ? 'POTENTIAL_STALE_GUIDANCE' : 'OLDER_REFERENCE_REVIEW';
      findings.push({ path, line: i + 1, version, classification });
    }
  }
  return findings;
}

export function buildReport(files, baseline, asOf) {
  parseVersion(baseline);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new TypeError('Specify an explicit YYYY-MM-DD snapshot date');
  const names = Object.keys(files).sort();
  return {
    baseline,
    as_of: asOf,
    baseline_provenance: 'caller-supplied; NOT independently checked against GitHub or installed devices',
    result_kind: 'manual review candidates; not verified stale bugs',
    scanned: names,
    findings: names.flatMap((name) => inspectFile(name, files[name], baseline)),
  };
}

function runCli() {
  const [flagRelease, release, flagDate, asOf, ...rest] = process.argv.slice(2);
  if (flagRelease !== '--release' || flagDate !== '--as-of' || rest.length) {
    console.error('Usage: node scripts/delegated/versions-k09/version-reference-report.mjs --release v1.0.8 --as-of 2026-11-01');
    process.exitCode = 2;
    return;
  }
  try {
    // Fixed public documentation set; no arbitrary path traversal or external reads.
    const files = Object.fromEntries(DEFAULT_FILES.map((name) => [name, readFileSync(resolve(process.cwd(), name), 'utf8')]));
    process.stdout.write(`${JSON.stringify(buildReport(files, release, asOf), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Version audit failed');
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
