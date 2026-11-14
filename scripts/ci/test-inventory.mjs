/**
 * Read-only, commit-pinned TypeScript test inventory.
 *
 * The shell's double-star test-file pattern does NOT imply recursive discovery in
 * bash unless globstar is enabled. Never equate npm test's exit code with
 * evidence that every tracked test file ran.
 *
 * This file ONLY inventories. It never executes tests, edits files, or claims
 * that a discovered test has passed. The optional --assert-legacy-complete flag
 * intentionally fails if a plain Bash ** glob omits files.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const TEST_FILE = /^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/;
const SHA = /^[0-9a-f]{40}$/;
const HEX_MODE = /^[0-7]{6}$/;

function reject(reason) {
  throw new Error('TEST_INVENTORY_' + reason);
}

/** Parse stage-zero entries only. Duplicate/staged/untrusted paths fail closed. */
export function parseGitStageEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) reject('NOT_BUFFER');
  const entries = [];
  const seen = new Set();
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const m = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t(.+)$/.exec(record);
    if (!m) reject('INVALID_GIT_STAGE_RECORD');
    const [,mode,blob,stage,relative] = m;
    if (!HEX_MODE.test(mode) || !SHA.test(blob) || stage !== '0') reject('UNMERGED_OR_INVALID_INDEX');
    if (relative.includes('\\') || relative.startsWith('/') ||
        relative.split('/').some(s => !s || s === '.' || s === '..')) reject('UNSAFE_PATH');
    if (seen.has(relative)) reject('DUPLICATE_PATH');
    seen.add(relative);
    if (!TEST_FILE.test(relative)) continue;
    if (mode !== '100644' && mode !== '100755') reject('NONREGULAR_TEST_FILE');
    entries.push({path: relative, mode, blob});
  }
  entries.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return entries;
}

/** Read the immutable HEAD tree instead of silently trusting a modified index. */
export function parseGitCommitTreeEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) reject('TREE_NOT_BUFFER');
  const entries = [];
  const seen = new Set();
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const m = /^([0-7]{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
    if (!m) reject('INVALID_COMMIT_TREE_RECORD');
    const [,mode,blob,relative] = m;
    if (relative.includes('\\') || relative.startsWith('/') ||
        relative.split('/').some(s => !s || s === '.' || s === '..'))
      reject('UNSAFE_COMMIT_TREE_PATH');
    if (seen.has(relative)) reject('DUPLICATE_COMMIT_TREE_PATH');
    seen.add(relative);
    if (!TEST_FILE.test(relative)) continue;
    if (mode !== '100644' && mode !== '100755') reject('NONREGULAR_TREE_TEST_FILE');
    entries.push({path:relative,mode,blob});
  }
  entries.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return entries;
}

export function summarizeTestFiles(entries, commitSha) {
  if (!SHA.test(commitSha) || !Array.isArray(entries) || entries.length === 0)
    reject('EMPTY_OR_UNPINNED');
  const paths = new Set();
  const counts = {root:0, oneDirectory:0, deeper:0};
  const manifest = [];
  for (const entry of entries) {
    if (!TEST_FILE.test(entry.path) ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        !SHA.test(entry.blob) || paths.has(entry.path)) reject('INVALID_TEST_ENTRY');
    paths.add(entry.path);
    const depth = entry.path.split('/').length;
    if (depth === 2) counts.root++;
    else if (depth === 3) counts.oneDirectory++;
    else counts.deeper++;
    manifest.push(entry.mode + ' ' + entry.blob + '\t' + entry.path + '\n');
  }
  const digest = createHash('sha256').update(manifest.join('')).digest('hex');
  return {
    schemaVersion:1,
    commitSha,
    manifestSha256:digest,
    trackedTsTestFiles:entries.length,
    byDepth:counts,
    legacyBashGlob:{
      expression:'test/**/*.test.ts',
      requiresBashGlobstarForRecursiveDiscovery:true,
      matchedWithoutGlobstar:counts.oneDirectory,
      omittedWithoutGlobstar:counts.root + counts.deeper,
      coverageClaim:'PATH_DISCOVERY_ONLY_NOT_EXECUTION_PROOF',
    },
    physicalWindowsAcceptance:'NOT_INFERRED',
  };
}

export function readTestInventory(repoRoot) {
  const commitSha = execFileSync('git',['rev-parse','HEAD'],{
    cwd:repoRoot,encoding:'utf8',maxBuffer:1024*1024,
  }).trim();
  const rawIndex = execFileSync('git',['ls-files','--stage','-z','--','test'],{
    cwd:repoRoot,encoding:'buffer',maxBuffer:16*1024*1024,
  });
  const rawHead = execFileSync('git',['ls-tree','-r','-z','HEAD','--','test'],{
    cwd:repoRoot,encoding:'buffer',maxBuffer:16*1024*1024,
  });
  const indexEntries = parseGitStageEntries(rawIndex);
  const entries = parseGitCommitTreeEntries(rawHead);
  if (JSON.stringify(indexEntries) !== JSON.stringify(entries))
    reject('INDEX_HEAD_TREE_MISMATCH');
  const dirty = spawnSync('git',['diff','--name-only','-z','HEAD','--','test'],{
    cwd:repoRoot,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
  });
  if (dirty.error || dirty.status !== 0)
    reject('WORKTREE_DIFF_UNVERIFIED');
  if (dirty.stdout.split('\0').some(relative => TEST_FILE.test(relative)))
    reject('TRACKED_TEST_WORKTREE_DIRTY');
  for (const entry of entries) {
    const file = path.resolve(repoRoot, ...entry.path.split('/'));
    if (!file.startsWith(path.resolve(repoRoot) + path.sep)) reject('OUTSIDE_REPO');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) reject('TEST_NOT_REGULAR_ON_DISK');
  }
  return {entries, report:summarizeTestFiles(entries,commitSha)};
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const flags = process.argv.slice(2);
    const allowed = new Set(['--json','--list','--assert-legacy-complete']);
    if (flags.some(x => !allowed.has(x)) ||
        (flags.includes('--json') && flags.includes('--list')))
      reject('USAGE');
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const {entries,report} = readTestInventory(repo);
    if (flags.includes('--assert-legacy-complete') && report.legacyBashGlob.omittedWithoutGlobstar)
      reject('LEGACY_BASH_GLOB_INCOMPLETE_' + report.legacyBashGlob.omittedWithoutGlobstar);
    if (flags.includes('--list')) {
      for (const entry of entries) process.stdout.write(entry.path + '\n');
    } else {
      process.stdout.write(JSON.stringify(report) + '\n');
    }
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'TEST_INVENTORY_UNKNOWN') + '\n');
    process.exitCode = 1;
  }
}
