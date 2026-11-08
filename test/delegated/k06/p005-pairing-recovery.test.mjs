import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (filename) => readFileSync(path.join(root, filename), 'utf8');
const guide = read('docs/INSTALL_WINDOWS.md');
const prompt = read('docs/CHATGPT_INSTALL_PROMPT.md');
const connect = read('web/connect.js');

const heading = 'BAĞLA hata metni ve güvenli yeniden deneme';
const anchor = 'bağla-hata-metni-ve-güvenli-yeniden-deneme';
const errorGuide = guide.split(`### ${heading}\n`)[1]?.split(/\n#{2,3} /)[0] ?? '';

test('P005 T-425 #485: source pairing messages match user-facing recovery guide', () => {
  const actualMessages = [
    'Bu hesap için cihaz limiti dolu.',
    'Bu cihaz bu hesaba bağlanamadı.',
    'Bağlantı hazırlanamadı.',
    'Bağlantı cevabı geçersiz.',
    'Hesap doğrulanamadı. Lütfen tekrar dene.',
    'BAĞLANIYOR…',
  ];
  assert.ok(errorGuide.length > 900, 'recovery section not found');
  for (const message of actualMessages) {
    assert.ok(connect.includes(message), `source message changed: ${message}`);
    assert.ok(errorGuide.includes(message), `recovery entry missing: ${message}`);
  }
  assert.match(errorGuide, /403 yanıtının ayrıntısı ekranda verilmez/);
  assert.match(errorGuide, /BAĞLA` etkinleşmez/);
});

test('P005 T-426 #485: one checkout links prompt, recovery heading and original decision tree', () => {
  const tree = 'Oluştur / BAĞLA başarısızsa: hızlı karar ağacı';
  const treeAnchor = 'oluştur--bağla-başarısızsa-hızlı-karar-ağacı';
  assert.ok(guide.includes(`### ${heading}`));
  assert.ok(guide.includes(`### ${tree}`));
  assert.ok(guide.includes(`(#${anchor})`));
  assert.ok(prompt.includes(`(INSTALL_WINDOWS.md#${anchor})`));
  assert.ok(prompt.includes(`(INSTALL_WINDOWS.md#${treeAnchor})`));
  assert.match(guide, /TEKRAR DENE.*?yeni oturum/s);
  assert.match(prompt, /BAĞLANIYOR… veya TEKRAR DENE/);
});

function sharedErrorInstructionsAreUnsafe(text) {
  return [
    /(?:tam|ham)\s+(?:URL|oturum bağlantısı|hata URL'si)[^.!\n]{0,80}(?:paylaş|gönder|yapıştır)/i,
    /(?:token|cookie|OAuth kodu)\s+[^.!\n]{0,40}(?:paylaş|gönder|yapıştır)/i,
  ].some((pattern) => pattern.test(text));
}

test('P005 T-427 #485: unredacted exception echo is a known source defect, never safe-to-share', () => {
  assert.match(connect, /error instanceof Error \? error\.message : String\(error\)/);
  assert.match(connect, /\$\('error-message'\)\.textContent = message/);
  assert.match(errorGuide, /ham hata metnini gösterebiliyor/);
  assert.match(errorGuide, /otomatik\s+gizlendiği anlamına gelmez/);
  for (const secret of ['token', 'state', 'pairing_id', 'OAuth kodu', 'cookie']) {
    assert.ok(errorGuide.includes(secret), `${secret} redaction guidance missing`);
  }
  assert.match(prompt, /otomatik gizlediğini varsayma/);
  assert.equal(sharedErrorInstructionsAreUnsafe(errorGuide + '\n' + prompt), false);
  assert.equal(sharedErrorInstructionsAreUnsafe('Tam URL gönder, sonra bağlantı düzelir.'), true);
  assert.equal(sharedErrorInstructionsAreUnsafe('Cookie değerini paylaş, hatayı çözebiliriz.'), true);
});

test('P005 T-428 #269: published checksum does not establish a signed native helper', () => {
  assert.match(guide, /Get-FileHash/);
  assert.match(guide, /Bu checksum, yayıncı imzası veya CORE fiziksel yetki kanıtı değildir/);
  assert.match(guide, /Node çalıştırıcısının imzası da Nexowire kurucusunun/);
  assert.match(guide, /imza\/yardımcı uygulama/);
  assert.match(guide, /NOT_RUN/i);
  assert.match(prompt, /hash'i\s+yayıncı imzası veya güvenlik onayı gibi sunma/);
});

function unsafeWindowsGuidance(text) {
  return /Set-ExecutionPolicy\s+(?:Bypass|Unrestricted)|-Verb\s+RunAs|DisableRealtimeMonitoring|DisableAntiSpyware|Stop-Service\s+WinDefend|takeown\s+\/F/iu.test(text);
}

test('P005 T-429 #485: no unsafe SmartScreen, policy or admin escalation shortcuts', () => {
  assert.match(guide, /SmartScreen'i, antivirüsü veya uygulama denetimini devre dışı bırakma/);
  assert.match(guide, /Yönetici olarak çalıştır.*gerekmez/);
  assert.match(prompt, /yönetici yükseltme/);
  assert.equal(unsafeWindowsGuidance(guide + '\n' + prompt), false);
  assert.equal(unsafeWindowsGuidance('Set-ExecutionPolicy Bypass'), true);
  assert.equal(unsafeWindowsGuidance('Start-Process -Verb RunAs'), true);
  assert.equal(unsafeWindowsGuidance('Stop-Service WinDefend'), true);
});

test('P005 T-430 #485: release evidence is historical, not a live-device or current-API PASS', () => {
  const snapshot = JSON.parse(read('test/delegated/k06/release-v108-assets.snapshot.json'));
  assert.ok(snapshot, 'snapshot missing');
  assert.match(guide, /releases\/download\/v1\.0\.8\/Nexowire-Setup\.cmd/);
  assert.match(prompt, /releases\/download\/v1\.0\.8\/Nexowire-Setup\.cmd/);
  assert.match(guide, /gerçek Windows yükseltme ve geri dönüş kabulü bu kılavuzda \*\*NOT_RUN\*\*/i);
  assert.match(guide, /İmza ve temiz Windows kurulumu bağımsız/);
  assert.doesNotMatch(guide, /bu GitHub testinin çalışması Windows 10\/11 kabulüdür/i);
});
