import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const install = read('docs/INSTALL_WINDOWS.md');
const prompt = read('docs/CHATGPT_INSTALL_PROMPT.md');
const readme = read('README.md');
const release = read('docs/RELEASE.md');
const pkg = JSON.parse(read('package.json'));

const section = (markdown, heading) => {
  const start = markdown.indexOf(`### ${heading}`);
  if (start < 0) return '';
  const next = markdown.slice(start + 4).search(/\n#{2,3} /);
  return next < 0 ? markdown.slice(start) : markdown.slice(start, start + 4 + next);
};

function githubAnchor(heading) {
  return heading.toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .replace(/ /g, '-');
}

function unsupportedPromise(text) {
  return [
    /Nexowire-Setup\.cmd\s+(?:dosyası\s+)?imzalıdır/i,
    /Nexowire(?:'ın)?\s+(?:resmî\s+)?kurucusu\s+Authenticode\s+imzalıdır/i,
    /(?:kurulum|güncelleme)\s+her\s+hata(?:da|yı)\s+otomatik\s+onarır/i,
    /(?:yede[kğ]leme|geri\s+alma)\s+garantidir/i,
  ].filter((pattern) => pattern.test(text)).map(String);
}

test('#485: kurulum mesajı, README, sürüm notu ve paket sürümü aynı', () => {
  const published = release.match(/latest published stable version is \[v(\d+\.\d+\.\d+)\]/)?.[1];
  assert.ok(published, 'published stable version not parseable');
  assert.equal(published, pkg.version);
  const asset = `https://github.com/Naveax/Nexowire/releases/download/v${published}/Nexowire-Setup.cmd`;
  for (const [name, text] of [['README', readme], ['INSTALL_WINDOWS', install], ['CHATGPT_INSTALL_PROMPT', prompt]]) {
    assert.ok(text.includes(asset), `${name} incorrect current installer`);
  }
  assert.match(readme, /Windows 10\/11, 64 bit \(x64\)/);
  assert.match(install, /Windows 10\/11 \*\*x64\*\*/);
});

test('#485: BAĞLA ve Oluştur karar ağacı başarısız ekranları ayırıyor', () => {
  const tree = section(install, 'Oluştur / BAĞLA başarısızsa: hızlı karar ağacı');
  assert.ok(tree.length > 400, 'decision tree missing');
  const expected = [
    /1\. \*\*Yalnız indir\/kur ekranı/, /2\. \*\*Cihaz adı ve BAĞLA/,
    /3\. \*\*`TEKRAR DENE`/, /4\. \*\*Cihaz panelde çevrimiçi ama ChatGPT'de Oluştur/,
    /5\. \*\*Eklenti bağlı ama `devices_list` boş/,
  ];
  for (const pattern of expected) assert.match(tree, pattern);
  assert.match(tree, /resource/);
  assert.match(tree, /OAuth/);
  assert.match(tree, /cihazı yeniden kurma/);
  assert.match(prompt, /kurulumun kendiliğinden\s+düzeldiğini/);
});

test('#485: karar ağacı bağlantısı gerçek başlık ankrajına gidiyor', () => {
  const heading = 'Oluştur / BAĞLA başarısızsa: hızlı karar ağacı';
  const anchor = githubAnchor(heading);
  assert.ok(install.includes(`### ${heading}`));
  assert.ok(prompt.includes(`(INSTALL_WINDOWS.md#${anchor})`));
  assert.equal(anchor, 'oluştur--bağla-başarısızsa-hızlı-karar-ağacı');
});

test('#269: hash ile Nexowire Authenticode imzası bir tutulmuyor', () => {
  assert.match(install, /#269'un kabul koşullarında/);
  assert.match(install, /Node çalıştırıcısının imzası da Nexowire kurucusunun/);
  assert.match(install, /imzalı Nexowire yükleyicisi hazır/);
  assert.deepEqual(unsupportedPromise(install + '\n' + prompt), []);
  assert.ok(unsupportedPromise('Nexowire-Setup.cmd imzalıdır').length);
});

test('#485: kesinti/onarım/geri alma fiziki kabul olarak sunulmuyor', () => {
  assert.match(install, /otomatik onarım, eksiksiz yedekleme veya hatasız geri alma garantisi/);
  assert.match(install, /gerçek Windows yükseltme ve geri dönüş kabulü bu kılavuzda \*\*NOT_RUN\*\*/i);
  assert.match(install, /\.nexowire.*dosyalarını\s+silme/);
  assert.equal(unsupportedPromise('Kurulum her hatayı otomatik onarır').length, 1);
});
