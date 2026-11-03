import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const targets = [
  'README.md',
  'docs/INSTALL_WINDOWS.md',
  'docs/SELF_HOST.md',
  'docs/DEPLOYMENT_ONBOARDING.md',
];

// A deliberately narrow, offline QA sentinel for common dangerous wording,
// not a URL resolver, security enforcement layer, or live connector test.
function suspiciousAdvice(line) {
  const value = line.replace(/\*\*/g, '').trim();
  const issues = [];
  const denied = /\b(?:do not|don't|never|avoid|must not|cannot|is not|not to)\b|(?:kullanma|yapıştırma|ekleme|tahmin etme|kopyalama|girme)\b/i.test(value);
  const remoteContext = /chatgpt|connector|sunucu adresi|server url|remote|uzak/i.test(value);
  const affirmative = /\b(?:use|paste|enter|configure|set|append|add|point|choose)\b|(?:kullan|yapıştır|gir|ekle|ayarla)/i.test(value);
  const loopbackHttp = /http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/i.test(value);
  const publicHttp = /http:\/\/(?!localhost(?=[:/\s]|$)|127\.0\.0\.1(?=[:/\s]|$)|0\.0\.0\.0(?=[:/\s]|$))[a-z0-9.-]+(?:[:/]\S*)?/i.test(value);
  const panelGuess = /(?:control.?panel|giriş paneli|panel adresi).{0,100}(?:\/mcp.{0,50}(?:ekle|append|add)|(?:ekle|append|add).{0,50}\/mcp)/i.test(value);
  const exposedQuery = /https?:\/\/\S+[?&](?:token|api_key|secret|access_token)=[^\s&)]+/i.test(value);

  if (!denied && remoteContext && affirmative && loopbackHttp) issues.push('remote-loopback');
  if (!denied && remoteContext && affirmative && publicHttp) issues.push('plaintext-remote-http');
  if (!denied && affirmative && panelGuess) issues.push('guessed-panel-mcp');
  if (exposedQuery) issues.push('secret-in-url');
  return issues;
}

test('dangerous English and Turkish endpoint suggestions are rejected', () => {
  const examples = [
    ['For ChatGPT, use http://localhost:43110/mcp as the server URL.', 'remote-loopback'],
    ['ChatGPT sunucu adresine http://127.0.0.1:43110/mcp yapıştır.', 'remote-loopback'],
    ['Use http://public.example.org/mcp for the remote connector.', 'plaintext-remote-http'],
    ['Control-panel URL: append /mcp to this panel address.', 'guessed-panel-mcp'],
    ['Giriş paneli adresine /mcp ekle.', 'guessed-panel-mcp'],
    ['Open https://example.org/mcp?token=FAKE_TEST_VALUE in a browser.', 'secret-in-url'],
  ];
  for (const [sample, expected] of examples) {
    assert.ok(suspiciousAdvice(sample).includes(expected), `Missed ${expected}: ${sample}`);
  }
});

test('explicit warnings and canonical OAuth guidance do not become false positives', () => {
  const safe = [
    'Do not use http://localhost:43110/mcp as a remote ChatGPT connector URL.',
    'ChatGPT sunucu adresine http://127.0.0.1:43110/mcp yapıştırma.',
    'Copy the official hosted MCP resource URL and choose OAuth.',
    'Local Hub address http://127.0.0.1:43110/mcp stays on the same PC.',
    'Never append /mcp to the login panel address by guessing.',
  ];
  for (const sample of safe) {
    assert.deepEqual(suspiciousAdvice(sample), [], `False positive: ${sample}`);
  }
});

test('current end-user and operator guides contain no flagged affirmative URL advice', async () => {
  let checked = 0;
  for (const file of targets) {
    const content = await readFile(path.join(root, file), 'utf8');
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const issues = suspiciousAdvice(line);
      assert.deepEqual(issues, [], `${file}:${index + 1}: ${issues.join(', ')}`);
      checked++;
    }
  }
  assert.ok(checked >= 100, 'Guard against a vacuous empty-document scan');
});
