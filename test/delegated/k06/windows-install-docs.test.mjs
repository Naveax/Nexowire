import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => readFileSync(path.join(repo, name), 'utf8');
const README = 'README.md';
const WINDOWS = 'docs/INSTALL_WINDOWS.md';
const PROMPT = 'docs/CHATGPT_INSTALL_PROMPT.md';
const RELEASE = 'https://github.com/Naveax/Nexowire/releases/download/v1.0.8/Nexowire-Setup.cmd';

function withoutFences(markdown) {
  let fence = null;
  return markdown.split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const type = marker[1][0];
      if (fence === null) fence = type;
      else if (type === fence) fence = null;
      return '';
    }
    return fence === null ? line : '';
  }).join('\n');
}

function headings(markdown) {
  const counts = new Map();
  const anchors = new Set();
  for (const line of withoutFences(markdown).split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = heading[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
    const index = counts.get(slug) ?? 0;
    anchors.add(index ? `${slug}-${index}` : slug);
    counts.set(slug, index + 1);
  }
  return anchors;
}

function brokenLocalLinks(markdown, from) {
  const failures = [];
  const sourcePath = path.join(repo, from);
  const links = withoutFences(markdown).matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+[^)]*)?\)/g);
  for (const [, destination] of links) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) continue;
    const [rawFile, rawAnchor] = destination.split('#', 2);
    const local = decodeURIComponent(rawFile);
    const targetPath = path.resolve(path.dirname(sourcePath), local || path.basename(sourcePath));
    if (!targetPath.startsWith(`${repo}${path.sep}`) && targetPath !== repo) {
      failures.push(`${destination}: repo dışına taşıyor`);
      continue;
    }
    if (!existsSync(targetPath)) {
      failures.push(`${destination}: dosya yok`);
      continue;
    }
    if (rawAnchor && !headings(readFileSync(targetPath, 'utf8')).has(decodeURIComponent(rawAnchor))) {
      failures.push(`${destination}: başlık ankrajı yok`);
    }
  }
  return failures;
}

test('Windows kılavuzu ve ChatGPT kurulum mesajının yerel bağlantı/ankrajları mevcut', () => {
  for (const filename of [WINDOWS, PROMPT]) {
    assert.deepEqual(brokenLocalLinks(read(filename), filename), [], filename);
  }
  assert.deepEqual(brokenLocalLinks(
    read(README).split('\n').filter((line) =>
      line.includes('(docs/INSTALL_WINDOWS.md') || line.includes('(docs/CHATGPT_INSTALL_PROMPT.md')
    ).join('\n'), README
  ), []);
});

test('bağlantı denetçisi bozuk dosya ve ankrajı PASS saymaz', () => {
  assert.deepEqual(brokenLocalLinks('[bozuk](docs/olmayan-k06.md)', README),
    ['docs/olmayan-k06.md: dosya yok']);
  assert.deepEqual(brokenLocalLinks('[bozuk](docs/INSTALL_WINDOWS.md#olmayan-baslik)', README),
    ['docs/INSTALL_WINDOWS.md#olmayan-baslik: başlık ankrajı yok']);
});

test('üç giriş belgesi aynı v1.0.8 indirmesini ve eski kurucu arşiv sınırını gösterir', () => {
  for (const filename of [README, WINDOWS, PROMPT]) {
    const contents = read(filename);
    assert.ok(contents.includes(RELEASE), `${filename}: güncel kurucu bulunamadı`);
    assert.ok(contents.includes('v1.0.7') && contents.includes('arşiv'),
      `${filename}: arşiv kurucusu uyarısı bulunamadı`);
  }
  assert.doesNotMatch(read(PROMPT), /fix\/first-pc-onboarding-guide-20261029|Download raw|releases\/tag\/v1\.0\.7/);
});

test('MCP resource/panel ayrımı, OAuth ve güvenli hata kurtarma adımları korunur', () => {
  const guide = read(WINDOWS);
  const prompt = read(PROMPT);
  for (const text of [guide, prompt]) {
    assert.match(text, /oauth-protected-resource/);
    assert.match(text, /\bresource\b/);
    assert.match(text, /OAuth/);
    assert.match(text, /BAĞLA/);
    assert.match(text, /TEKRAR DENE/);
    assert.match(text, /Oluştur/);
    assert.match(text, /API anahtarı/);
  }
  assert.match(guide, /kontrol paneli/);
  assert.match(guide, /No authentication/);
  assert.match(guide, /şifre|Şifre/);
  assert.match(prompt, /giriş paneline \/mcp ekleyip tahmin etme/);
});
