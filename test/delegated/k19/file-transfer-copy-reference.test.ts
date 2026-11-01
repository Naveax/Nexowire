import test from 'node:test';
import assert from 'node:assert/strict';

// Test-only presentation reference for future UI integration. These functions
// are NOT wired into an MCP tool, browser, Agent, or a production status view.
type Readback = 'not_checked' | 'unavailable' | 'sha256_matched' | 'different';
type UserState = 'IN_PROGRESS' | 'COMPLETE' | 'VERIFIED' | 'CONFLICT' | 'UNKNOWN';
type Outcome = {
  pending?: boolean;
  response?: {ok: boolean; state?: string};
  readback?: Readback;
  cleanupVerifiedAbsent?: boolean;
};

function proposedPresentation(outcome: Outcome): {
  state: UserState;
  status: string;
  retry: string;
  cleanup: string;
} {
  const readback = outcome.readback ?? 'not_checked';
  const cleanup = outcome.cleanupVerifiedAbsent
    ? 'Geçici dosyanın yokluğu ayrıca doğrulandı.'
    : 'Geçici dosyanın temizlendiği doğrulanmadı.';

  if (outcome.pending) return {
    state: 'IN_PROGRESS',
    status: 'Aktarım sürüyor; hedef henüz doğrulanmadı.',
    retry: 'Sonuç belli olmadan yeniden başlatma.', cleanup,
  };
  if (readback === 'sha256_matched') return {
    state: 'VERIFIED',
    status: 'Hedef dosya bağımsız SHA-256 doğrulamasıyla eşleşti.',
    retry: 'Aynı dosyanın üzerine yazma.', cleanup,
  };
  if (readback === 'different') return {
    state: 'CONFLICT',
    status: 'Hedef dosya mevcut ancak beklenen içerikle eşleşmiyor.',
    retry: 'Mevcut dosyayı koru; farklı ad seç.', cleanup,
  };
  if (outcome.response?.ok === true && outcome.response.state === 'COMPLETE') {
    return {
      state: 'COMPLETE',
      status: 'Aktarım tamamlandı.',
      retry: 'Tekrar aktarım gerekmiyor.', cleanup,
    };
  }
  return {
    state: 'UNKNOWN',
    status: 'Aktarım sonucu bilinmiyor; hedef dosyanın durumu doğrulanmadı.',
    retry: 'Doğrulama olmadan yeniden deneme. Bu işlem kaldığı yerden devam etmez.',
    cleanup,
  };
}

function fileNamePreview(fullPath: string, maxGraphemes = 32) {
  // A UI should not leak a user path if it only needs the basename.
  const filename = fullPath.split(/[\\/]/u).at(-1) ?? '';
  const graphemes = [...new Intl.Segmenter('tr', {granularity: 'grapheme'})
    .segment(filename)].map(item => item.segment);
  const preview = graphemes.length > maxGraphemes
    ? graphemes.slice(0, maxGraphemes).join('') + '…' : filename;
  return {preview, accessibleName: filename};
}

test('T-224: interruption without trusted destination readback stays UNKNOWN', () => {
  for (const response of [undefined, {ok: false}, {ok: false, state: 'COMPLETE'}]) {
    const result = proposedPresentation({response, readback: 'unavailable'});
    assert.equal(result.state, 'UNKNOWN');
    assert.match(result.status, /bilinmiyor/);
    assert.doesNotMatch(result.status, /tamamlandı|başarılı|%100/i);
    assert.match(result.retry, /Doğrulama olmadan/);
  }
});

test('T-225: a generic EEXIST-like error alone cannot certify a safe conflict label', () => {
  const unverified = proposedPresentation({response: {ok: false}});
  assert.equal(unverified.state, 'UNKNOWN');
  const conflict = proposedPresentation({
    response: {ok: false}, readback: 'different',
  });
  assert.equal(conflict.state, 'CONFLICT');
  assert.match(conflict.retry, /Mevcut dosyayı koru/);
  assert.doesNotMatch(conflict.retry, /üzerine yaz|sil ve/i);
});

test('T-226: retry copy never implies resumability after lost acknowledgement', () => {
  const unknown = proposedPresentation({response: {ok: false}, readback: 'not_checked'});
  assert.equal(unknown.state, 'UNKNOWN');
  assert.match(unknown.retry, /kaldığı yerden devam etmez/);
  const verified = proposedPresentation({readback: 'sha256_matched'});
  assert.equal(verified.state, 'VERIFIED');
  assert.match(verified.status, /SHA-256/);
  assert.doesNotMatch(verified.status, /yeniden aktarıldı/);
});

test('T-227: long Unicode names preserve graphemes and accessible full basename', () => {
  const filename = '🧪👩🏽‍💻-Ş' + 'a\u0308'.repeat(70) + '-rapor.txt';
  for (const fullPath of ['C:\\Users\\Owner\\' + filename, '/home/owner/' + filename]) {
    const result = fileNamePreview(fullPath);
    assert.equal(result.accessibleName, filename);
    assert.ok(result.preview.endsWith('…'));
    assert.ok([...new Intl.Segmenter('tr', {granularity: 'grapheme'})
      .segment(result.preview)].length <= 33);
    assert.equal(result.preview.startsWith('🧪👩🏽‍💻-Ş'), true);
    assert.doesNotMatch(result.preview, /Users|home|owner/);
  }
});

test('T-229: best-effort cleanup is UNKNOWN until separately verified', () => {
  const error = proposedPresentation({response: {ok: false}});
  assert.match(error.cleanup, /doğrulanmadı/);
  const complete = proposedPresentation({response: {ok: true, state: 'COMPLETE'}});
  assert.equal(complete.state, 'COMPLETE');
  assert.match(complete.cleanup, /doğrulanmadı/);
  const checked = proposedPresentation({cleanupVerifiedAbsent: true});
  assert.match(checked.cleanup, /ayrıca doğrulandı/);
});
