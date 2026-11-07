import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const fixture = JSON.parse(read('test/delegated/k06/release-v108-assets.snapshot.json'));
const docs = [
  ['README.md', read('README.md')],
  ['docs/INSTALL_WINDOWS.md', read('docs/INSTALL_WINDOWS.md')],
  ['docs/CHATGPT_INSTALL_PROMPT.md', read('docs/CHATGPT_INSTALL_PROMPT.md')],
];

function releaseDownloadTargets(contents) {
  return [...contents.matchAll(/https:\/\/github\.com\/Naveax\/Nexowire\/releases\/download\/[^\s)\]"']+/g)]
    .map((match) => match[0]);
}

function classifyDownload(url, release) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return 'INVALID_URL'; }
  if (parsed.origin !== 'https://github.com' || parsed.search || parsed.hash) return 'INVALID_ORIGIN_OR_PARAMS';
  const match = parsed.pathname.match(/^\/Naveax\/Nexowire\/releases\/download\/([^/]+)\/([^/]+)$/);
  if (!match) return 'INVALID_RELEASE_PATH';
  if (match[1] !== release.tag) return 'STALE_OR_UNKNOWN_TAG';
  if (!release.assets.includes(decodeURIComponent(match[2]))) return 'ASSET_NOT_IN_RELEASE_SNAPSHOT';
  return 'MATCHES_RELEASE_SNAPSHOT';
}

test('T-383 #485: snapshot açıkça tarihli, kaynağı GitHub API ve yedi gerçek asset içeriyor', () => {
  assert.equal(fixture.evidence_kind, 'GITHUB_RELEASE_API_SNAPSHOT_NOT_LIVE_CI');
  assert.equal(fixture.latest_tag_at_observation, fixture.tag);
  assert.match(fixture.source, /^https:\/\/api\.github\.com\/repos\/Naveax\/Nexowire\/releases\/tags\//);
  assert.equal(fixture.assets.length, 7);
  assert.ok(fixture.assets.includes('Nexowire-Setup.cmd'));
});

test('T-383 #485: README, Windows ve ChatGPT kurucu URL değerleri yayın snapshotındaki gerçek asset ile eşleşir', () => {
  for (const [name, contents] of docs) {
    const targets = releaseDownloadTargets(contents);
    assert.ok(targets.length > 0, `${name}: installer download link missing`);
    for (const target of targets) {
      assert.equal(classifyDownload(target, fixture), 'MATCHES_RELEASE_SNAPSHOT', `${name}: ${target}`);
    }
  }
});

test('T-383 #485: sürüm notu ve kurulum bağlantıları tarihli latest snapshotı ile çelişmez', () => {
  const releaseDocs = read('docs/RELEASE.md');
  assert.ok(releaseDocs.includes(`latest published stable version is [${fixture.tag}]`));
  assert.ok(releaseDocs.includes(`https://github.com/Naveax/Nexowire/releases/tag/${fixture.tag}`));
  assert.ok(read('package.json').includes(`"version": "${fixture.tag.slice(1)}"`));
  assert.match(read('README.md'), /\]\(https:\/\/github\.com\/Naveax\/Nexowire\/releases\/latest\)/);
});

test('T-383 negatifleri: eski tag, olmayan asset, parametre ve sahte origin PASS değildir', () => {
  const good = 'https://github.com/Naveax/Nexowire/releases/download/v1.0.8/Nexowire-Setup.cmd';
  assert.equal(classifyDownload(good, fixture), 'MATCHES_RELEASE_SNAPSHOT');
  assert.equal(classifyDownload(good.replace('v1.0.8', 'v1.0.7'), fixture), 'STALE_OR_UNKNOWN_TAG');
  assert.equal(classifyDownload(good.replace('Nexowire-Setup.cmd', 'Nexowire-Setup.exe'), fixture),
    'ASSET_NOT_IN_RELEASE_SNAPSHOT');
  assert.equal(classifyDownload(`${good}?download=1`, fixture), 'INVALID_ORIGIN_OR_PARAMS');
  assert.equal(classifyDownload(good.replace('github.com', 'github.example.invalid'), fixture),
    'INVALID_ORIGIN_OR_PARAMS');
});

test('T-383 #485: eski repo arşiv kurucusu mevcut kurulum bağlantısı olarak önerilmiyor', () => {
  for (const [name, contents] of docs.slice(0, 2)) {
    assert.doesNotMatch(contents, /\]\((?:\.\.\/)?installers\/Nexowire-Setup\.cmd\?raw=true\)/,
      `${name}: archive raw installer is falsely recommended`);
  }
  assert.match(read('docs/INSTALL_WINDOWS.md'), /arşivdir; \*\*yeni kurulum için kullanma\*\*/);
});
