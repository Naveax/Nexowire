#!/usr/bin/env node
/** Inventory test path ownership; basename collision != actual write conflict. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_NAME = /(?:\.test|\.spec)\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/i;

function enumerate(directory, output = []) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) return output;
  if (stat.isDirectory()) for (const entry of readdirSync(directory).sort()) enumerate(join(directory, entry), output);
  else if (stat.isFile() && TEST_NAME.test(directory)) output.push(directory);
  return output;
}

export function ownerForPath(path) {
  const match = path.replace(/\\/g, '/').match(/^test\/delegated\/(k\d{2})\//);
  return match ? match[1].toUpperCase() : 'upstream/unassigned';
}

export function inventory(root, paths = null) {
  const repo = realpathSync(root);
  const testFiles = (paths || enumerate(resolve(repo, 'test'))).map(file => {
    const rel = relative(repo, resolve(file)).replaceAll(sep, '/');
    if (rel.startsWith('../') || rel === '..') throw new Error(`Outside repository: ${file}`);
    return { path: rel, name: basename(rel), owner: ownerForPath(rel) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const byBasename = new Map();
  for (const file of testFiles) {
    const paths = byBasename.get(file.name) || [];
    paths.push(file);
    byBasename.set(file.name, paths);
  }
  const basenameCollisions = [...byBasename.entries()].filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, paths: files.map(x => x.path),
      owners: [...new Set(files.map(x => x.owner))].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const ownerCounts = Object.fromEntries([...new Set(testFiles.map(x => x.owner))].sort()
    .map(owner => [owner, testFiles.filter(x => x.owner === owner).length]));
  return { total: testFiles.length, ownerCounts, basenameCollisions,
    files: testFiles };
}

function main() {
  if (process.argv.length > 3) throw new Error('Usage: node test-ownership.mjs [repo-root]');
  const report = inventory(process.argv[2] || '.');
  console.log(JSON.stringify({ total: report.total, ownerCounts: report.ownerCounts,
    basenameCollisions: report.basenameCollisions }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 ownership: ${err.message}`); process.exitCode = 1; }
}
