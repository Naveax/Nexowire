import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditHtml, auditErrorBindings } from '../../../scripts/delegated/k05/audit-html.mjs';
import { normalizeFixturePath } from '../../../scripts/delegated/k05/fixture-path.mjs';

const rootUrl = new URL('../../../', import.meta.url);
const source = (path) => readFileSync(new URL(path, rootUrl), 'utf8');
const page = (body) => `<html lang="tr"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;
const rules = (html) => auditHtml(page(html)).findings.map((item) => item.rule);

test('T-025: live pages expose named static form fields, buttons and links', () => {
  for (const path of ['web/index.html', 'web/custom-usage-consent-preview.html']) {
    assert.deepEqual(auditHtml(source(path), path).findings, [], path);
  }
  assert.deepEqual(auditHtml(source('web/connect.html'), 'web/connect.html').findings.map(({ rule }) => rule),
    ['nested-live-region']); // Source finding owned by K01, not waived as PASS.
});

test('T-025: missing explicit label is caught even when input has a placeholder', () => {
  assert.ok(rules('<input id="search" placeholder="Ara">').includes('unnamed-control'));
  assert.deepEqual(rules('<label for="search">Ara</label><input id="search" placeholder="Ara">'), []);
  assert.deepEqual(rules('<label>Ara <input type="search"></label>'), []);
});

test('T-025: aria-labelledby resolves even hidden reference text; missing names fail', () => {
  assert.deepEqual(rules('<span hidden id="title">Kullanıcı adı</span><input aria-labelledby="title">'), []);
  assert.ok(rules('<button aria-label=" "><span aria-hidden="true">+</span></button>').includes('unnamed-action'));
  assert.ok(rules('<a href="/" aria-label=" "><span aria-hidden="true">→</span></a>').includes('unnamed-action'));
});

test('T-025: duplicate IDs and orphan for labels are errors', () => {
  const found = rules('<label for="missing">Ad</label><input id="same" aria-label="Ad"><div id="same"></div>');
  assert.ok(found.includes('duplicate-id'));
  assert.ok(found.includes('broken-label'));
});

test('T-026: nonnative clickable controls need a focus path and semantic role', () => {
  const found = rules('<div onclick="go()">İlerle</div>');
  assert.ok(found.includes('keyboard-unreachable'));
  assert.ok(found.includes('missing-interactive-role'));
  assert.ok(rules('<div role="button" onclick="go()">İlerle</div>').includes('keyboard-unreachable'));
  assert.deepEqual(rules('<button type="button">İlerle</button><a href="/">Geri</a>'), []);
});

test('T-026: tab role and keyboard focus metadata are checked at source level', () => {
  assert.ok(rules('<button role="tab">Windows</button>').includes('tab-without-panel'));
  assert.deepEqual(rules('<button role="tab" aria-controls="panel">Windows</button><div id="panel" role="tabpanel"></div>'), []);
  const js = source('web/connect.js');
  assert.match(js, /addEventListener\('keydown'/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(js.includes(key));
  assert.match(js, /\.focus\(\)/);
});

test('T-026: aria-hidden keyboard targets are caught (including nested targets)', () => {
  assert.ok(rules('<button aria-hidden="true">Gizli</button>').includes('hidden-focusable'));
  assert.ok(rules('<div aria-hidden="true"><a href="/">Gizli</a></div>').includes('hidden-focusable'));
});

test('T-027: role status/alert, valid live properties and missing aria references', () => {
  assert.deepEqual(rules('<p role="status" aria-live="polite">Hazır</p><div role="alert">Hata</div>'), []);
  assert.ok(rules('<p aria-live="loud">Hata</p>').includes('invalid-live'));
  assert.ok(rules('<p role="alert" aria-live="off">Hata</p>').includes('suppressed-live'));
  assert.ok(rules('<input aria-label="Kod" aria-describedby="no-description">').includes('broken-reference'));
});

test('T-027: error panels without announcements are findings, not false PASS', () => {
  const admin = auditHtml(source('web/admin.html'), 'web/admin.html');
  assert.deepEqual(admin.findings.map((item) => item.rule), ['silent-error-panel']);
  assert.ok(rules('<section class="error-panel">Hata</section>').includes('silent-error-panel'));
  assert.deepEqual(rules('<section class="error-panel" role="alert">Hata</section>'), []);
});

test('T-028: error message target, panel containment and JS textContent contract', () => {
  const html = page('<div id="error-panel" class="error-panel" role="alert">Hata: <p id="error-message"></p></div>');
  const js = "$('error-message').textContent = detail; $('error-panel').classList.remove('hidden');";
  assert.deepEqual(auditErrorBindings(html, js, 'fixture', { panel: 'error-panel', message: 'error-message' }).findings, []);
  const broken = auditErrorBindings(page('<p id="error-message"></p><div id="error-panel" role="alert" class="error-panel">Hata</div>'),
    "$('error-message').innerHTML = detail;", 'fixture', { panel: 'error-panel', message: 'error-message' });
  for (const expected of ['error-message-outside-panel', 'error-binding', 'unsafe-error-sink']) {
    assert.ok(broken.findings.some(({ rule }) => rule === expected), expected);
  }
});

test('T-028: main/connect/admin scripts write errors as text, IDs resolve', () => {
  for (const [htmlFile, jsFile, panel, message] of [
    ['web/index.html', 'web/app.js', 'error-panel', 'error-message'],
    ['web/connect.html', 'web/connect.js', 'error-panel', 'error-message'],
    ['web/admin.html', 'web/admin.js', 'admin-error', 'admin-error-message'],
  ]) {
    const found = auditErrorBindings(source(htmlFile), source(jsFile), htmlFile, { panel, message }).findings;
    assert.ok(!found.some(({ rule }) => ['missing-error-id', 'error-binding', 'unsafe-error-sink',
      'error-message-outside-panel'].includes(rule)), htmlFile);
  }
});

test('T-029: mobile viewport is present on all current pages and missing value is detected', () => {
  for (const path of ['web/index.html', 'web/connect.html', 'web/admin.html', 'web/custom-usage-consent-preview.html']) {
    assert.ok(!auditHtml(source(path)).findings.some(({ rule }) => rule === 'missing-mobile-viewport'));
  }
  assert.ok(auditHtml('<html><body><button>İlerle</button></body></html>')
    .findings.some(({ rule }) => rule === 'missing-mobile-viewport'));
});

test('T-029: CSS includes visible keyboard focus and mobile rules (not pixel evidence)', () => {
  const css = source('web/styles.css');
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /@media\s*\(max-width:\s*620px\)/);
  // CSS source checks do not establish 44x44 CSS pixels or actual touchscreen usability.
});

test('T-030: source parser ignores markup-like text in scripts and comments', () => {
  const fixture = page('<!-- <input id="bad"> --><script>const x = "<input id=\\"bad\\">";</script><button>OK</button>');
  assert.deepEqual(auditHtml(fixture).findings, []);
});

test('T-136: fixture paths normalize POSIX, Windows drive and UNC inputs', () => {
  assert.equal(normalizeFixturePath('/repo/nexowire/test/delegated/a.test.mjs', '/repo/nexowire'),
    'test/delegated/a.test.mjs');
  assert.equal(normalizeFixturePath('C:\\Work\\Nexowire\\test\\data.html', 'c:\\work\\nexowire'),
    'test/data.html');
  assert.equal(normalizeFixturePath('\\\\server\\share\\project\\test\\file.html',
    '\\\\server\\share\\project'), 'test/file.html');
  assert.equal(normalizeFixturePath('test\\fixtures\\..\\case.html', '/repo/nexowire'), 'test/case.html');
});

test('T-136: outside, traversal, empty and malformed fixture paths cannot expose absolute paths', () => {
  for (const value of ['/repo/private/file.html', 'D:\\secret\\file.html',
    '../other/token.txt', 'test/../../secret', '/repo/nexowire2/file.html']) {
    assert.equal(normalizeFixturePath(value, '/repo/nexowire'), '<external-fixture>', value);
  }
  assert.equal(normalizeFixturePath('', '/repo/nexowire'), '<unknown-fixture>');
  assert.equal(normalizeFixturePath('bad\0file', '/repo/nexowire'), '<unknown-fixture>');
});

test('T-136: actual CLI labels are repo-relative even when absolute paths are passed', () => {
  const rootPath = fileURLToPath(rootUrl);
  const fixture = fileURLToPath(new URL('../../../web/index.html', import.meta.url));
  assert.equal(normalizeFixturePath(fixture, rootPath), 'web/index.html');
});

test('T-158: duplicate and nested live announcements fail, distinct statuses do not', () => {
  assert.ok(rules('<p role="status">Hazır</p><p role="status">Hazır</p>').includes('repeated-live-text'));
  assert.ok(rules('<div role="status"><p role="alert">Hata</p></div>').includes('nested-live-region'));
  assert.deepEqual(rules('<p role="status">Yükleniyor</p><p role="status">Bitti</p>'), []);
});

test('T-159: long Turkish Unicode labels and combining sequences remain meaningful', () => {
  const long = 'Şube, depo, gönderim, ücret ve teslimat bilgilerini doğrula '.repeat(8);
  assert.deepEqual(rules(`<label for="s">${long.normalize('NFD')}</label><input id="s">`), []);
  assert.deepEqual(rules('<label for="s">Şu\u00a0an\u0131n\u200b durumu</label><input id="s">'), []);
  assert.ok(rules('<input aria-label="\u200b\u200d\ufeff">').includes('unnamed-control'));
  assert.ok(rules('<label for="s">\u200b\u200d</label><input id="s">').includes('unnamed-control'));
});

test('T-160: disabled controls still need names but do not create false keyboard-focus findings', () => {
  assert.ok(rules('<button disabled aria-hidden="true"></button>').includes('unnamed-action'));
  assert.ok(!rules('<button disabled aria-hidden="true">Bekle</button>').includes('hidden-focusable'));
  assert.deepEqual(rules('<button disabled>Bekle</button><input disabled aria-label="Kod">'), []);
  assert.ok(rules('<input disabled placeholder="Ara">').includes('unnamed-control'));
});
