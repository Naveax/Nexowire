import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function collectDelegatedTests(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name)) {
        files.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  visit(root);
  return files.sort();
}

export function inspectDiscovery(ciSource, packageJson, delegatedTests) {
  const npmTest = packageJson.scripts?.test ?? '';
  // A commented example is not an executable CI invocation.
  const activeSource = ciSource.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
  const wildcardK20 = activeSource.includes('test/delegated/k20/*.test.mjs');
  const items = delegatedTests.map(path => {
    const inCI = activeSource.includes(path) ||
      (wildcardK20 && /^test\/delegated\/k20\/[^/]+\.test\.mjs$/.test(path));
    const npmPatternUnverified = !inCI && path.endsWith('.test.ts') &&
      npmTest.includes('test/**/*.test.ts');
    return {
      path,
      discovery: inCI ? 'EXPLICIT_CI' : npmPatternUnverified ? 'NPM_GLOB_UNVERIFIED' : 'NOT_REFERENCED',
    };
  });
  return {
    files: items.length,
    first_twenty: items.slice(0, 20),
    explicit_ci: items.filter(i => i.discovery === 'EXPLICIT_CI').length,
    npm_glob_unverified: items.filter(i => i.discovery === 'NPM_GLOB_UNVERIFIED').length,
    not_referenced: items.filter(i => i.discovery === 'NOT_REFERENCED').map(i => i.path),
    conclusion: items.every(i => i.discovery === 'EXPLICIT_CI')
      ? 'SOURCE_PATHS_REFERENCED_NOT_EXECUTION_PROOF' : 'INCOMPLETE_OR_UNVERIFIED_DISCOVERY',
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const repoRoot = resolve(process.argv[2] ?? '.');
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const paths = collectDelegatedTests(join(repoRoot, 'test/delegated'))
    .map(name => 'test/delegated/' + name);
  console.log(JSON.stringify(inspectDiscovery(ci, pkg, paths), null, 2));
}
