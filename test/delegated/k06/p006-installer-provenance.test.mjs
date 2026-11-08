import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const guide = read('docs/INSTALL_WINDOWS.md');
const prompt = read('docs/CHATGPT_INSTALL_PROMPT.md');
const page = read('web/connect.js');
const readme = read('README.md');

const officialAsset = 'https://github.com/Naveax/Nexowire/releases/download/v1.0.8/Nexowire-Setup.cmd';
// Provenance is intentionally pinned to reviewed upstream/main README blob. On any
// README change, inspect the changed source and refresh this assertion deliberately.
const reviewedReadmeBlob = 'ff50bf9d2f1f7b69e1594bcbb4a9ae42f137fc9b';

const gitBlobSha = (value) => createHash('sha1')
  .update(`blob ${Buffer.byteLength(value)}\0`)
  .update(value)
  .digest('hex');

function releaseMismatch(webSource, markdown) {
  const pinned = webSource.match(/const INSTALLER_REF = '([a-f0-9]{40})'/)?.[1];
  const archived = /v1\.0\.7 paketini doğrulayarak kullanır/.test(webSource);
  const currentRelease = markdown.includes(officialAsset);
  return Boolean(pinned && archived && currentRelease);
}

test('P006 T-565 #485: connect-page historical installer diverges from current README release', () => {
  assert.equal(releaseMismatch(page, readme), true);
  assert.equal(releaseMismatch(page.replace('v1.0.7 paketini', 'v1.0.8 paketini'), readme), false);
  assert.ok(guide.includes(officialAsset));
  assert.match(guide, /Bağlantı sayfası sürüm farkı/);
  assert.match(guide, /\*\*Windows\s+kurucusunu aç\*\*[\s\S]{0,200}`v1\.0\.7` arşiv/);
  assert.match(guide, /resmî v1\.0\.8 GitHub Releases indirmesini/);
  assert.match(prompt, /connect\.html sayfasındaki Windows/);
  assert.match(prompt, /düğme yerine yukarıdaki resmî v1\.0\.8 GitHub Releases adresini kullan/);
});

test('P006 T-566 #269: unsigned native helper and SmartScreen remain explicit stop gates', () => {
  assert.match(guide, /Native yardımcı kurucunun Nexowire yayıncı imzası doğrulanmadıysa/);
  assert.match(guide, /SmartScreen uyarısını geçerek kurucuyu güvenli veya kabul edilmiş sayma/);
  assert.match(guide, /imzası yerine geçmez/);
  assert.match(prompt, /hash'i\s+yayıncı imzası veya güvenlik onayı gibi sunma/);
  assert.doesNotMatch(guide + prompt, /Set-ExecutionPolicy\s+Bypass|Start-Process\s+-Verb\s+RunAs/);
});

test('P006 T-567 #485: pairing limit is a separate error and retry does not bypass it', () => {
  assert.match(page, /body\.error === 'DEVICE_LIMIT_REACHED'/);
  assert.match(page, /'Bu hesap için cihaz limiti dolu\.'/);
  assert.match(guide, /cihaz limiti dolu\.` \| Hesabın cihaz limitini kontrol et; tekrar BAĞLA sınırı kaldırmaz/);
});

test('P006 T-567 #485: dashboard failure disables pairing, not a connected device', () => {
  assert.match(page, /throw new Error\('Hesap doğrulanamadı\. Lütfen tekrar dene\.'\)/);
  assert.match(page, /approve\.disabled = !retryable/);
  assert.match(guide, /Hesap doğrulanamadı\. Lütfen tekrar dene\.` \| Hesap kontrolü tamamlanmadı ve `BAĞLA` etkinleşmez/);
  assert.match(prompt, /çevrimiçi görünmeden bağlantı tamamlandı deme/);
});

test('P006 T-567 #485: ChatGPT Create/OAuth failure is not a Windows pairing retry', () => {
  assert.match(guide, /ChatGPT'de \*\*Oluştur \/ Create\*\* başarısızsa/);
  assert.match(guide, /özel MCP sunucusu oluşturma izni/);
  assert.match(guide, /No authentication\*\* seçmek, rastgele `\/mcp` eklemek/);
  assert.match(prompt, /çalışma alanının eklenti iznini/);
  assert.match(guide, /kurucusunu\s+tekrar çalıştırmak bu sorunları güvenli biçimde çözmez/);
});

test('P006 T-568 #485: normal two-click installer does not require a CMD/PowerShell prerequisite', () => {
  assert.match(guide, /Normal indirme ve dosyaya çift tıklama için CMD, terminal veya yeni PowerShell\s+kurulumu gerekmez/);
  assert.match(guide, /İstersen indirdiğin kurucunun bütünlüğünü Windows PowerShell'de/);
  assert.match(guide, /Get-FileHash -LiteralPath/);
  assert.match(prompt, /önceden npm\/Node kurdurma/);
  assert.doesNotMatch(guide, /(?:CMD|PowerShell) kurulumu zorunludur/);
});

test('P006 T-569 #1006: reviewed README blob and official release URL are immutable QA inputs', () => {
  assert.equal(gitBlobSha(readme), reviewedReadmeBlob,
    'README changed; review new source SHA before claiming current installer provenance');
  assert.equal(gitBlobSha(readme.replace(officialAsset, 'https://untrusted.invalid/setup.cmd')) === reviewedReadmeBlob, false);
  assert.ok(readme.includes(officialAsset));
  for (const doc of [guide, prompt]) assert.ok(doc.includes(officialAsset));
  const snapshot = JSON.parse(read('test/delegated/k06/release-v108-assets.snapshot.json'));
  assert.equal(snapshot.latest_tag_at_observation, 'v1.0.8');
  assert.equal(snapshot.evidence_kind, 'GITHUB_RELEASE_API_SNAPSHOT_NOT_LIVE_CI');
});

test('P006 T-570 #485: five-way decision path is short, ordered, and does not conflate acceptance', () => {
  const heading = '### Oluştur / BAĞLA başarısızsa: hızlı karar ağacı';
  const section = guide.split(heading)[1]?.split(/\n## /)[0] ?? '';
  assert.match(section, /indirme\/kurulum → cihaz BAĞLA →\s+TEKRAR DENE → ChatGPT Oluştur → `devices_list`/);
  const steps = ['Yalnız indir/kur ekranı', 'Cihaz adı ve BAĞLA', '`TEKRAR DENE` veya süre aşımı', 'Cihaz panelde çevrimiçi ama ChatGPT', 'Eklenti bağlı ama `devices_list` boş'];
  let previous = -1;
  for (const label of steps) {
    const at = section.indexOf(label);
    assert.ok(at > previous, `step missing or out of order: ${label}`);
    previous = at;
  }
  assert.match(section, /görünmeyen başarıyı tahmin etme/);
  assert.match(section, /ham metni paylaşma/);
});
