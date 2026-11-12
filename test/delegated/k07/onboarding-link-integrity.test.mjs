import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');
const ownerDocs = ['docs/SELF_HOST.md', 'docs/DEPLOYMENT_ONBOARDING.md'];

function links(markdown) {
  return [...markdown.matchAll(/!?\[[^\]]+\]\(([^\s)]+)(?:\s+['"][^'"]*['"])?\)/g)]
    .map((match) => match[1]);
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const duplicates = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    if (!match) continue;
    const slug = match[1]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .trim().replace(/\s+/g, '-');
    const previous = duplicates.get(slug) ?? 0;
    duplicates.set(slug, previous + 1);
    anchors.add(previous ? `${slug}-${previous}` : slug);
  }
  return anchors;
}

async function brokenLocalLinks(source, markdown, load = read) {
  const broken = [];
  for (const href of links(markdown)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) continue;
    const [relative, fragment] = href.split('#', 2);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), relative || path.posix.basename(source)));
    if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) {
      broken.push(`${href}: escapes repository root`);
      continue;
    }
    let contents;
    try {
      contents = await load(target);
    } catch {
      broken.push(`${href}: missing ${target}`);
      continue;
    }
    if (fragment && target.endsWith('.md') && !headingAnchors(contents).has(decodeURIComponent(fragment))) {
      broken.push(`${href}: missing anchor #${fragment} in ${target}`);
    }
  }
  return broken;
}

function releaseFindings(markdown, observation) {
  const problems = [];
  const matchingInstallerLinks = links(markdown).filter((url) =>
    /^https:\/\/github\.com\/Naveax\/Nexowire\/releases\/download\//.test(url) && url.endsWith('/Nexowire-Setup.cmd'));
  if (matchingInstallerLinks.length !== 1 || matchingInstallerLinks[0] !== observation.installerUrl) {
    problems.push('public installer URL differs from verified GitHub release asset');
  }
  const unexpectedCmdDownloads = links(markdown).filter((url) =>
    /\.cmd(?:[?#].*)?$/i.test(url) && url !== observation.installerUrl);
  if (unexpectedCmdDownloads.length > 0) {
    problems.push('unexpected CMD download outside the verified GitHub release');
  }
  if (!markdown.includes(`Resmî ${observation.tag} Nexowire-Setup.cmd indir`)) {
    problems.push('download label/version differs from release tag');
  }
  if (!markdown.includes(`Resmî ${observation.tag} setup SHA-256:`) ||
      !markdown.includes(`\`${observation.installerSha256}\``)) {
    problems.push('documented installer checksum differs from release asset digest');
  }
  if (!markdown.includes('https://github.com/Naveax/Nexowire/releases/latest')) {
    problems.push('release overview link missing');
  }
  return problems;
}

test('operator onboarding Markdown local file and heading links resolve', async () => {
  for (const filename of ownerDocs) {
    const broken = await brokenLocalLinks(filename, await read(filename));
    assert.deepEqual(broken, [], `${filename}: ${broken.join(' | ')}`);
  }
});

test('Windows onboarding installer matches an observed GitHub release asset and digest', async () => {
  const install = await read('docs/INSTALL_WINDOWS.md');
  const observation = JSON.parse(await read('test/delegated/k07/fixtures/onboarding-release-observation.json'));
  assert.equal(observation.releaseDraft, false);
  assert.equal(observation.prerelease, false);
  assert.equal(observation.latestTagAtObservation, observation.tag);
  assert.ok(observation.installerSizeBytes > 0);
  assert.deepEqual(releaseFindings(install, observation), []);
});

test('negative fixtures expose missing local targets and changed anchors', async () => {
  const fakeDocs = new Map([
    ['docs/INSTALL_WINDOWS.md', '## ChatGPT adresini bulma\n'],
  ]);
  const load = async (filename) => {
    if (!fakeDocs.has(filename)) throw new Error('not found');
    return fakeDocs.get(filename);
  };
  assert.deepEqual(await brokenLocalLinks('docs/SELF_HOST.md',
    '[valid](INSTALL_WINDOWS.md#chatgpt-adresini-bulma)', load), []);
  const broken = await brokenLocalLinks('docs/SELF_HOST.md',
    '[missing](NOT_HERE.md) [old anchor](INSTALL_WINDOWS.md#old-heading)', load);
  assert.equal(broken.length, 2);
  assert.match(broken.join(' '), /missing docs\/NOT_HERE\.md/);
  assert.match(broken.join(' '), /missing anchor #old-heading/);
});

test('negative fixtures reject stale release versions, asset URLs and checksums', async () => {
  const install = await read('docs/INSTALL_WINDOWS.md');
  const observation = JSON.parse(await read('test/delegated/k07/fixtures/onboarding-release-observation.json'));
  assert.match(releaseFindings(install.replace('download/v1.0.8/', 'download/v1.0.7/'), observation).join(' '), /URL differs/);
  assert.match(releaseFindings(install.replace('Resmî v1.0.8 Nexowire-Setup', 'Resmî v1.0.9 Nexowire-Setup'), observation).join(' '), /label\/version differs/);
  assert.match(releaseFindings(install.replace(observation.installerSha256, '0'.repeat(64)), observation).join(' '), /checksum differs/);
  assert.match(releaseFindings(install + '\n[Unofficial installer](https://untrusted.example/Nexowire-Setup.cmd)', observation).join(' '), /unexpected CMD download/);
  assert.match(releaseFindings(install + '\n[Unverified script](https://untrusted.example/bootstrap.cmd?source=mirror)', observation).join(' '), /unexpected CMD download/);
});
