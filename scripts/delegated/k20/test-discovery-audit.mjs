#!/usr/bin/env node
/** Static pattern coverage, not proof that npm actually executed any test. */
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST = /\.(?:test|spec)\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/i;

function walk(path, files = []) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return files;
  if (st.isDirectory()) for (const entry of readdirSync(path).sort()) walk(join(path, entry), files);
  else if (st.isFile() && TEST.test(path)) files.push(path);
  return files;
}

export function discover(root, npmTestScript, paths = null) {
  if (typeof npmTestScript !== 'string') throw new TypeError('npm test script required');
  const repo = realpathSync(root);
  const files = (paths || walk(join(repo, 'test'))).map(x => relative(repo, x).replaceAll('\\', '/')).sort();
  // Recognize only a deliberately narrow explicit test/**/*.test.EXT form.
  // If not recognized, report UNKNOWN rather than guessing a glob's semantics.
  const patterns = [...npmTestScript.matchAll(/\btest\/\*\*\/\*\.(test|spec)\.([a-z\d]+)\b/gi)];
  if (!npmTestScript.includes('--test') || !patterns.length) {
    return { status: 'UNKNOWN', configuredPatterns: [], filesFound: files.length,
      potentiallyExcluded: files, note: 'Runner pattern unsupported by static checker; execution NOT_RUN' };
  }
  const accepted = new Set(patterns.map(x => `.${x[1]}.${x[2]}`.toLowerCase()));
  const potentiallyExcluded = files.filter(x => ![...accepted].some(suffix => x.toLowerCase().endsWith(suffix)));
  return { status: potentiallyExcluded.length ? 'POTENTIAL_GAP' : 'PATTERN_COVERED_NOT_EXECUTED',
    configuredPatterns: patterns.map(x => x[0]), filesFound: files.length,
    potentiallyExcluded, note: 'No test process was run; shell globstar and runner recursion require separate CI evidence' };
}

function main() {
  if (process.argv.length > 3) throw new Error('Usage: node test-discovery-audit.mjs [repo-root]');
  const root = process.argv[2] || '.';
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const result = discover(root, pkg.scripts?.test);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PATTERN_COVERED_NOT_EXECUTED') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 discovery: ${err.message}`); process.exitCode = 2; }
}
