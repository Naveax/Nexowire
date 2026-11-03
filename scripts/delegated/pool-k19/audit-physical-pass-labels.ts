import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Read-only source audit. A match is REVIEW_REQUIRED, never a finding of fraud
// or a substitute for independently verified hardware/device evidence.
export interface ReviewCandidate {
  file: string;
  line: number;
  excerpt: string;
  kind: 'PHYSICAL_PASS_REVIEW_REQUIRED';
}

const physical = /\b(?:real|physical|live|gerçek|fiziksel)\b[^\n]{0,110}\b(?:device|devices|cihaz|pc|windows|android|iphone|makine|machine|hardware|donanım)\b|\b(?:device|devices|cihaz|pc|windows|android|iphone|makine|machine|hardware|donanım)\b[^\n]{0,110}\b(?:real|physical|live|gerçek|fiziksel)\b/iu;
const pass = /\b(?:PASS|PASSED)\b|✅|\bBAŞARILI\b/iu;
const negated = /\b(?:NOT_RUN|UNVERIFIED|NO_GO|BLOCKED)\b|\b(?:PASS|PASSED)\b\s*(?:değil|sayılma[sz]|iddia\s+edilmi(?:yor|ştir)|not\s+proven)|\b(?:not|never|no)\b[^\n]{0,40}\b(?:PASS|PASSED)\b|kanıt(?:lanmadı|\s+yok)|doğrulanmadı/iu;

export function scanPhysicalPassClaims(content: string, file: string): ReviewCandidate[] {
  const result: ReviewCandidate[] = [];
  let fenced = false;
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (/^\s*(?:```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*<!--/u.test(line)) continue;
    // An adjacent CI PASS and physical NOT_RUN often share one Markdown line.
    // Keep those separate instead of inventing a physical PASS claim.
    for (const clause of line.split(/\s*;\s*|\s+[—–]\s+/u)) {
      if (!physical.test(clause) || !pass.test(clause) || negated.test(clause)) continue;
      result.push({
        file,
        line: index + 1,
        excerpt: clause.trim().slice(0, 240),
        kind: 'PHYSICAL_PASS_REVIEW_REQUIRED',
      });
    }
  }
  return result;
}

async function filesUnder(entry: string): Promise<string[]> {
  let info;
  try { info = await fs.lstat(entry); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (info.isSymbolicLink()) return [];
  if (info.isFile()) return /\.(?:md|txt)$/iu.test(entry) ? [entry] : [];
  if (!info.isDirectory() || ['node_modules', '.git', 'dist'].includes(path.basename(entry))) {
    return [];
  }
  const out: string[] = [];
  for (const name of (await fs.readdir(entry)).sort()) {
    out.push(...await filesUnder(path.join(entry, name)));
  }
  return out;
}

export async function auditPhysicalPassLabels(targets: string[]): Promise<ReviewCandidate[]> {
  // A typo in the requested root must not turn into a misleading clean scan.
  for (const target of targets) await fs.lstat(target);
  const paths = [...new Set((await Promise.all(targets.map(filesUnder))).flat())].sort();
  const result: ReviewCandidate[] = [];
  for (const file of paths) {
    const info = await fs.stat(file);
    if (info.size > 2 * 1024 * 1024) {
      throw new Error(`Audit file exceeds 2 MiB bound: ${file}`);
    }
    const contents = await fs.readFile(file, 'utf8');
    result.push(...scanPhysicalPassClaims(contents, file));
  }
  return result;
}

const invokedAsScript = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const targets = args.filter(arg => arg !== '--strict');
  try {
    const findings = await auditPhysicalPassLabels(targets.length ? targets : ['docs']);
    for (const issue of findings) {
      process.stdout.write(`${issue.file}:${issue.line}: ${issue.kind}: ${issue.excerpt}\n`);
    }
    process.stdout.write(`Physical PASS label review candidates: ${findings.length}\n`);
    if (strict && findings.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Audit could not complete: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
