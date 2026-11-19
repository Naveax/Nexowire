import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../../web/connect.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../../web/connect.js', import.meta.url), 'utf8');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Static ancestry only. This does not model NVDA or a browser accessibility tree.
function copyStatusLiveContext(markup) {
  const stack = [];
  for (const match of markup.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    const token = match[0];
    const tag = match[1].toLowerCase();
    if (token.startsWith('</')) {
      const i = stack.findLastIndex((item) => item.tag === tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(token)?.[1];
    const node = { tag, id: attr('id'),
      live: ['polite', 'assertive'].includes(attr('aria-live')) ||
        ['status', 'alert'].includes(attr('role')) };
    if (node.id === 'copy-status') {
      return { statusLive: node.live, ancestorLive: stack.filter((item) => item.live)
        .map((item) => item.id || item.tag) };
    }
    if (!VOID.has(tag) && !/\/>$/.test(token)) stack.push(node);
  }
  throw new Error('copy-status not found in web/connect.html');
}

async function exerciseRealCopyHandler({ rejectClipboard = false } = {}) {
  // Execute only the existing click callback under a narrowly mocked DOM/clipboard.
  const match = /\$\('copy-command'\)\.addEventListener\('click',\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n\}\);/.exec(js);
  assert.ok(match, 'the real copy-command click handler must exist');
  const events = [];
  let click;
  const controls = {
    'copy-command': { addEventListener(type, handler) {
      assert.equal(type, 'click');
      click = handler;
    } },
    'install-command': { value: 'installation-command-fixture',
      focus() { events.push('focus-command'); },
      select() { events.push('select-command'); } },
    'copy-status': { textContent: '' },
  };
  vm.runInNewContext(match[0], {
    $: (id) => controls[id],
    navigator: { clipboard: { async writeText(value) {
      events.push(`clipboard:${value}`);
      if (rejectClipboard) throw new Error('Clipboard permission denied');
    } } },
  }, { timeout: 1000 });
  assert.equal(typeof click, 'function');
  await click();
  return { feedback: controls['copy-status'].textContent, events };
}

test('W-605 SOURCE RED: copy confirmation must not be nested in another live region', () => {
  const context = copyStatusLiveContext(html);
  assert.equal(context.statusLive, true, 'copy-status needs a live announcement');
  assert.deepEqual(context.ancestorLive, [],
    'copy-status is already live; live #install-content is an additional announcement candidate');
});

test('W-606: isolated nested-live fixture is rejected and one-live-region remedy passes', () => {
  const nested = html.replace(/(id="install-content"\s+role="tabpanel")(?:\s+aria-live="polite")?/, '$1 aria-live="polite"');
  assert.ok(copyStatusLiveContext(nested).ancestorLive.includes('install-content'));
  const mitigated = nested.replace(/(id="install-content"\s+role="tabpanel")\s+aria-live="polite"/, '$1');
  assert.notEqual(mitigated, nested, 'fixture must remove outer aria-live');
  const context = copyStatusLiveContext(mitigated);
  assert.equal(context.statusLive, true);
  assert.deepEqual(context.ancestorLive, []);
});

test('W-605: real copy handler writes a confirmation to the nested status', async () => {
  const result = await exerciseRealCopyHandler();
  assert.equal(result.feedback, 'Komut kopyalandı.');
  assert.deepEqual(result.events, ['clipboard:installation-command-fixture']);
});

test('W-609: denied clipboard takes the keyboard focus and selection recovery path', async () => {
  const result = await exerciseRealCopyHandler({ rejectClipboard: true });
  assert.match(result.feedback, /Ctrl\+C veya Cmd\+C/);
  assert.deepEqual(result.events, ['clipboard:installation-command-fixture', 'focus-command', 'select-command']);
});

test('W-609/610: viewport allows zoom in source, physical keyboard/NVDA still NOT_RUN', () => {
  const viewport = /<meta\s+name="viewport"\s+content="([^"]+)"/i.exec(html)?.[1] ?? '';
  assert.match(viewport, /width=device-width/);
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/i);
});
