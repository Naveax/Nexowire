import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function listDelegatedTests(repoRoot) {
  const base = join(repoRoot, 'test/delegated');
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name)) {
        files.push(relative(repoRoot, full).split(sep).join('/'));
      }
    }
  }
  walk(base);
  return files.sort();
}

// This checks which paths the *source text* names; it never asserts that a
// GitHub Actions runner actually executed the tests or completed a device gate.
export function auditMainCiSource({ ciSource, npmTestCommand, paths }) {
  // Only actual node --test shell commands establish source-call evidence.
  // Mentions in echo, YAML labels and unexecuted prose must not count.
  const commands = [];
  let blockIndent = null;
  let continued = false;
  let folded = false;
  for (const raw of ciSource.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(raw);
    if (run) {
      blockIndent = /^[|>][-+]?\s*$/.test(run[2]) ? run[1].length : null;
      folded = /^>[-+]?\s*$/.test(run[2]);
      continued = false;
      if (/^node\s+--test\b/.test(run[2].trim())) commands.push(run[2].trim());
      continue;
    }
    if (blockIndent === null) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (indent <= blockIndent) { blockIndent = null; continued = false; continue; }
    const shell = raw.trim();
    if (/^node\s+--test\b/.test(shell)) {
      commands.push(shell);
      continued = folded || shell.endsWith('\\');
    } else if (continued && /^test\//.test(shell)) {
      commands.push(shell);
      continued = folded || shell.endsWith('\\');
    } else continued = false;
  }
  const invoked = new Set(commands.join(' ').match(/test\/[A-Za-z0-9_./*+-]+\.test\.(?:ts|mjs)(?![\w.-])/g) ?? []);
  const k20Wildcard = invoked.has('test/delegated/k20/*.test.mjs');
  const npmOneDirGlob = /(?:^|\s)test\/\*\*\/\*\.test\.ts(?:\s|$)/.test(npmTestCommand);
  const items = [...paths].sort().map(path => {
    const explicit = invoked.has(path) ||
      (k20Wildcard && /^test\/delegated\/k20\/[^/]+\.test\.mjs$/.test(path));
    // npm uses a non-interactive POSIX shell on Linux. Unless globstar has
    // been explicitly enabled, ** is a single path component, not recursion.
    const npmOneLevel = npmOneDirGlob && /^test\/[^/]+\/[^/]+\.test\.ts$/.test(path);
    return {
      path,
      source_coverage: explicit ? 'EXPLICIT_WORKFLOW_SOURCE' :
        npmOneLevel ? 'NPM_ONE_DIRECTORY_GLOB' : 'NO_KNOWN_INVOCATION',
    };
  });
  return {
    evidence_level: 'SOURCE_INVENTORY_NOT_EXECUTION_PROOF',
    total: items.length,
    explicit_source: items.filter(x => x.source_coverage === 'EXPLICIT_WORKFLOW_SOURCE').length,
    npm_one_directory_glob: items.filter(x => x.source_coverage === 'NPM_ONE_DIRECTORY_GLOB').length,
    no_known_invocation: items.filter(x => x.source_coverage === 'NO_KNOWN_INVOCATION').map(x => x.path),
    physical_device: 'NOT_RUN',
    release_acceptance: 'NOT_RUN',
    items,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(process.argv[2] ?? '.');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ciSource = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const output = auditMainCiSource({
    ciSource, npmTestCommand: pkg.scripts?.test ?? '', paths: listDelegatedTests(root),
  });
  console.log(JSON.stringify({ checkout_sha: process.env.GITHUB_SHA ?? 'UNKNOWN', ...output }, null, 2));
}
