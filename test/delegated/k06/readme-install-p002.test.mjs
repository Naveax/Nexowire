import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (filename) => readFileSync(path.join(root, filename), 'utf8');
const README = source('README.md');
const INSTALL = source('docs/INSTALL_WINDOWS.md');
const PROMPT = source('docs/CHATGPT_INSTALL_PROMPT.md');

function proseOnly(markdown) {
  let fence = null;
  return markdown.split('\n').map((line) => {
    const candidate = line.match(/^\s*(`{3,}|~{3,})/);
    if (candidate) {
      const marker = candidate[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

function markdownLinks(markdown) {
  return [...proseOnly(markdown).matchAll(/\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)]
    .map(([, label, target]) => ({ label, target }));
}

function markdownAnchors(markdown) {
  const counts = new Map();
  const result = new Set();
  for (const line of proseOnly(markdown).split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    // GitHub-style Markdown heading IDs; Turkish characters are retained.
    const slug = heading[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
    const repeat = counts.get(slug) ?? 0;
    result.add(repeat ? `${slug}-${repeat}` : slug);
    counts.set(slug, repeat + 1);
  }
  return result;
}

function invalidLocalLinks(markdown, from) {
  const errors = [];
  for (const { target } of markdownLinks(markdown)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const [rawFile, rawAnchor] = target.split('#', 2);
    const filepath = path.resolve(root, path.dirname(from), decodeURIComponent(rawFile || path.basename(from)));
    if (!filepath.startsWith(`${root}${path.sep}`) || !existsSync(filepath)) {
      errors.push(`${target}: file missing or out of repo`);
      continue;
    }
    if (rawAnchor && !markdownAnchors(readFileSync(filepath, 'utf8')).has(decodeURIComponent(rawAnchor))) {
      errors.push(`${target}: anchor missing`);
    }
  }
  return errors;
}

function dangerousInstallCommands(text) {
  return [
    /-ExecutionPolicy\s+Bypass/i,
    /Set-MpPreference/i,
    /\bRemove-Item\b/i,
    /\brmdir\s+\/s\b/i,
    /\b(?:curl|wget)\b[^\n]*\|\s*(?:iex|sh|bash)\b/i,
  ].filter((expression) => expression.test(text)).map(String);
}

test('README Windows/ChatGPT link adları doğru hedeflere işaret ediyor', () => {
  const links = markdownLinks(README);
  const has = (label, target) => links.some((link) => link.label.includes(label) && link.target === target);
  assert.ok(has('kurulum mesajını', 'docs/CHATGPT_INSTALL_PROMPT.md'));
  assert.ok(has('ayrıntılı Windows', 'docs/INSTALL_WINDOWS.md'));
  assert.ok(has('Ayrıntılı yardım', 'docs/INSTALL_WINDOWS.md#sorun-yaşarsan'));
  assert.ok(has('Nexowire bağlantı sayfasındaki ChatGPT',
    'https://nexowire-control-plane.nexowire-naveax.workers.dev/connect.html#chatgpt'));
  assert.ok(has('Kontrol paneline dön', 'https://nexowire-control-plane.nexowire-naveax.workers.dev/'));
  assert.ok(has('Resmî Nexowire v1.0.8',
    'https://github.com/Naveax/Nexowire/releases/download/v1.0.8/Nexowire-Setup.cmd'));
  assert.doesNotMatch(README, /\]\(installers\/Nexowire-Setup\.cmd\?raw=true\)/);
});

test('README ve iki kurulum belgesinde tüm göreli dosya/başlık linkleri geçerli', () => {
  for (const [filename, markdown] of [
    ['README.md', README],
    ['docs/INSTALL_WINDOWS.md', INSTALL],
    ['docs/CHATGPT_INSTALL_PROMPT.md', PROMPT],
  ]) assert.deepEqual(invalidLocalLinks(markdown, filename), [], filename);
});

test('link denetçisi kayıp dosya, kayıp ankraj ve ikinci eş ad başlığı doğru reddeder', () => {
  assert.deepEqual(invalidLocalLinks('[bozuk](docs/x-k06.md)', 'README.md'),
    ['docs/x-k06.md: file missing or out of repo']);
  assert.deepEqual(invalidLocalLinks('[bozuk](docs/INSTALL_WINDOWS.md#does-not-exist)', 'README.md'),
    ['docs/INSTALL_WINDOWS.md#does-not-exist: anchor missing']);
  assert.deepEqual([...markdownAnchors('# İki başlık\n# İki başlık')], ['iki-başlık', 'iki-başlık-1']);
  assert.deepEqual(markdownLinks('```md\n[hayali](missing.md)\n```\n[gerçek](README.md)'),
    [{ label: 'gerçek', target: 'README.md' }]);
});

test('hesap uyuşmazlığı, SmartScreen ve MCP örneği güvenli yönlendiriliyor', () => {
  assert.match(INSTALL, /başka GitHub hesabında görünüyorsa/i);
  assert.match(INSTALL, /cihazları silme/i);
  assert.match(PROMPT, /hangi GitHub hesabıyla/);
  assert.match(INSTALL, /SmartScreen'i, antivirüsü.*devre dışı bırakma/s);
  assert.match(INSTALL, /example\.invalid/);
  assert.match(INSTALL, /gerçek Nexowire adresi\s+değildir/);
  assert.match(INSTALL, /authorization_servers/);
  assert.match(INSTALL, /yalnız `resource` değeridir/);
  assert.match(INSTALL, /Get-FileHash -LiteralPath \(Join-Path \$env:USERPROFILE 'Downloads\\Nexowire-Setup\.cmd'\) -Algorithm SHA256/);
});

test('dokümanlar canlı kabulü sentetik kanıtla karıştırmıyor ve riskli komut önermiyor', () => {
  assert.match(INSTALL, /NOT_RUN/);
  assert.match(INSTALL, /Cloudflare/);
  assert.match(INSTALL, /machine_health/);
  assert.match(INSTALL, /iki-PC kabulü/);
  assert.deepEqual(dangerousInstallCommands(INSTALL + '\n' + PROMPT), []);
  assert.ok(dangerousInstallCommands('powershell -ExecutionPolicy Bypass -File install.ps1').length);
});
