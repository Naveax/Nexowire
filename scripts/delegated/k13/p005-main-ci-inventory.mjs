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
  const activeCi = ciSource.split(/\r?\n/)
    .filter(line => !/^\s*#/.test(line)).join('\n');
  const k20Wildcard = activeCi.includes('test/delegated/k20/*.test.mjs');
  const npmOneDirGlob = /(?:^|\s)test\/\*\*\/\*\.test\.ts(?:\s|$)/.test(npmTestCommand);
  const items = [...paths].sort().map(path => {
    const explicit = activeCi.includes(path) ||
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
