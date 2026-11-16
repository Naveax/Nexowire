import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => readFile(path.join(root, file), 'utf8');

function section(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === title);
  assert.notEqual(start, -1, `Missing recovery section: ${title}`);
  const depth = title.match(/^#+/)?.[0].length ?? 0;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const headingDepth = line.match(/^#+(?=\s)/)?.[0].length ?? 0;
    return headingDepth > 0 && headingDepth <= depth;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function unsafePairingInstructions(text) {
  const reasons = [];
  if (/(?:\b(?:rm\s+-rf|Remove-Item|del\s+\/f)\b|--force\b|(?:run|execute|use)\s+(?:nexowire\s+)?node connector)/i.test(text)) {
    reasons.push('destructive or secret-revealing command');
  }
  if (/(?:paste|post|gönder|paylaş)[^\n.]{0,60}(?:OAuth code|bearer token|session cookie|OAuth kodu|şifre)/i.test(text)) {
    reasons.push('secret sent to support');
  }
  if (/(?:127\.0\.0\.1|localhost)[^\n.]{0,80}(?:ChatGPT connector|ChatGPT bağlantı adresi)/i.test(text)) {
    reasons.push('loopback offered to remote connector');
  }
  return reasons;
}

test('hosted pairing recovery avoids delete/reinstall and distinguishes one retry from a new session', async () => {
  const guide = await read('docs/INSTALL_WINDOWS.md');
  const pairing = section(guide, '## 3. Cihazı kendi hesabına bağla');
  for (const phrase of ['BAĞLA görünmüyor', 'BAĞLANIYOR', 'TEKRAR DENE', 'yeni', 'eşleme oturumu', 'cihaz limiti dolu']) {
    assert.ok(pairing.includes(phrase), `Missing pairing recovery step: ${phrase}`);
  }
  assert.match(pairing, /`TEKRAR DENE`[^\n]*yalnız o düğmeyi bir kez kullan/);
  assert.match(pairing, /Eski eşleme sekmesini, yerel uygulama klasörünü\s*\n?veya cihaz kayıtlarını silme/);
  assert.match(pairing, /tekrar tekrar denemek limiti kaldırmaz/);
  assert.deepEqual(unsafePairingInstructions(pairing), []);
});

test('wrong GitHub identity recovery reauthorizes the matching account without exposing OAuth secrets', async () => {
  const guide = await read('docs/INSTALL_WINDOWS.md');
  const mismatch = section(guide, '### Cihaz başka GitHub hesabında görünüyorsa');
  assert.match(mismatch, /farklı bir GitHub\s*\n?hesabı/);
  assert.match(mismatch, /yeniden yetkilendirmeyi dene/);
  assert.match(mismatch, /Cihazı yeniden kurma\s*\n?veya mevcut cihazları silme/);
  assert.match(mismatch, /cookie, OAuth kodu, oturum URL'si/);
  assert.deepEqual(unsafePairingInstructions(mismatch), []);
});

test('self-host disconnection recovery uses status before state-changing bootstrap or token reveal', async () => {
  const guide = await read('docs/SELF_HOST.md');
  const recovery = section(guide, '### After a disconnection: diagnostic-first recovery');
  for (const command of ['node status', 'hub status', 'agent doctor', 'tailscale status']) {
    assert.ok(recovery.includes(`\`nexowire ${command}\``), `Missing diagnostic ${command}`);
  }
  assert.match(recovery, /Do not issue new credentials, clear state or run a service reinstall/);
  assert.match(recovery, /node connector.*not.*diagnostic.*reveals a bearer token/i);
  assert.deepEqual(unsafePairingInstructions(recovery), []);
});

test('negative recovery fixtures reject secret sharing, forced reset and misleading localhost advice', () => {
  assert.deepEqual(unsafePairingInstructions('Try TEKRAR DENE once; reopen the Nexowire app.'), []);
  assert.match(unsafePairingInstructions('Run rm -rf ~/.nexowire then retry.').join(' '), /destructive/);
  assert.match(unsafePairingInstructions('Use onboard bootstrap --force to repair pairing.').join(' '), /destructive/);
  assert.match(unsafePairingInstructions('Please post your OAuth code to support.').join(' '), /secret sent/);
  assert.match(unsafePairingInstructions('Use http://127.0.0.1:43110/mcp as your ChatGPT connector.').join(' '), /loopback/);
});
