/**
 * Offline, synthetic contract checks for the delegated HTML prototypes.
 * A minimal DOM stub executes the real inline state script; it does NOT render
 * CSS, implement keyboard navigation or replace a browser/screen-reader audit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const onboarding = readFileSync(new URL('../../docs/delegated/prototypes/onboarding.html', import.meta.url), 'utf8');
const quota = readFileSync(new URL('../../docs/delegated/prototypes/quota-preview.html', import.meta.url), 'utf8');

type Listener = (event?: { target: FakeElement }) => void;
interface FakeElement {
  id: string;
  value: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  attributes: Map<string, string>;
  listeners: Map<string, Listener>;
  addEventListener(type: string, listener: Listener): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  focus(): void;
}

const requiredIds = [
  'state', 'status', 'step1', 'step2', 'download', 'installed', 'signin',
  'bind', 'retry', 'connect', 'failure', 'done',
] as const;

function simulatedOnboarding() {
  const ids = [...onboarding.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  let focused = '';
  const elements: Record<string, FakeElement> = {};
  for (const id of requiredIds) {
    assert.equal(ids.filter(value => value === id).length, 1, `exactly one element with id=${id}`);
    const listeners = new Map<string, Listener>();
    const attributes = new Map<string, string>();
    elements[id] = {
      id, value: '', textContent: '', hidden: false, disabled: false,
      listeners, attributes,
      addEventListener(type, listener) { listeners.set(type, listener); },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      focus() { focused = id; },
    };
  }
  const inlineScript = onboarding.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript, 'onboarding must provide its local inline state script');
  runInNewContext(inlineScript, {
    document: {
      getElementById(id: string) {
        assert.ok(elements[id], `unknown document element: ${id}`);
        return elements[id];
      },
    },
    // A regression that tries to make an external call must fail this test.
    fetch() { throw new Error('Network access is forbidden in synthetic UI'); },
    XMLHttpRequest: class { constructor() { throw new Error('XHR forbidden'); } },
    WebSocket: class { constructor() { throw new Error('WebSocket forbidden'); } },
  });
  function fire(id: string, type: string) {
    const element = elements[id]!;
    const listener = element.listeners.get(type);
    assert.ok(listener, `${id} must handle ${type}`);
    listener({ target: element });
  }
  return {
    el: (id: (typeof requiredIds)[number]) => elements[id]!,
    fire,
    focused: () => focused,
    choose(value: string) { elements.state!.value = value; fire('state', 'change'); },
  };
}

test('both HTML previews are explicitly offline, synthetic and non-production', () => {
  for (const [name, source] of [['onboarding', onboarding], ['quota', quota]] as const) {
    assert.match(source, /DEMO \/ CANLI VERİ DEĞİL/, name);
    assert.match(source, /default-src 'none';/, name);
    assert.match(source, /connect-src 'none';/, name);
    assert.match(source, /form-action 'none';/, name);
    assert.doesNotMatch(source, /<(?:iframe|form)\b|<(?:script|link)\b[^>]+(?:src|href)=/i, name);
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\s*\(/, name);
  }
  assert.match(onboarding, /Gerçek hesabın veya cihazın okunmadı/);
  assert.match(onboarding, /Gerçek bağlantı veya CORE\/yönetici yetkisi kanıtı değildir/);
  assert.match(quota, /Bu ekran hesabına bağlı değildir/);
});

test('mobile and focus-visible CSS contracts exist (not a rendered overflow test)', () => {
  for (const source of [onboarding, quota]) {
    assert.match(source, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(source, /@media\(max-width:480px\)/);
    assert.match(source, /button,select\{width:100%\}/);
    assert.match(source, /button:focus-visible,select:focus-visible/);
    assert.match(source, /outline:3px solid #ffe293/);
    assert.doesNotMatch(source, /\btabindex="[1-9]/);
  }
});

test('onboarding has native labelled controls and a polite live status', () => {
  assert.match(onboarding, /<label for="state">Sentetik ekran<\/label>/);
  assert.match(onboarding, /<select id="state">/);
  assert.match(onboarding, /id="status" role="status" aria-live="polite" aria-atomic="true"/);
  const buttons = [...onboarding.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  assert.equal(buttons.length, 5);
  for (const button of buttons) assert.match(button, /type="button"/);
  for (const id of ['connect', 'failure', 'done']) {
    assert.match(onboarding, new RegExp(`<section id="${id}"[^>]* hidden>`));
  }
});

test('initial state does not claim a connected device', () => {
  const ui = simulatedOnboarding();
  assert.equal(ui.el('state').value, 'start');
  assert.match(ui.el('status').textContent, /Başlangıç/);
  assert.equal(ui.el('connect').hidden, true);
  assert.equal(ui.el('failure').hidden, true);
  assert.equal(ui.el('done').hidden, true);
  assert.equal(ui.el('download').disabled, false);
  assert.equal(ui.el('step1').attributes.get('aria-current'), 'step');
  assert.equal(ui.el('step2').attributes.has('aria-current'), false);
});

test('loading disables the download control but never asserts success', () => {
  const ui = simulatedOnboarding();
  ui.fire('download', 'click');
  assert.equal(ui.el('state').value, 'loading');
  assert.equal(ui.el('download').disabled, true);
  assert.equal(ui.el('connect').hidden, true);
  assert.equal(ui.el('done').hidden, true);
  assert.equal(ui.el('step1').attributes.get('aria-current'), 'step');
  assert.equal(ui.focused(), 'state');
});

test('install and sign-in previews expose step two without claiming binding', () => {
  const ui = simulatedOnboarding();
  ui.fire('installed', 'click');
  assert.equal(ui.el('state').value, 'installed');
  assert.equal(ui.el('connect').hidden, false);
  assert.equal(ui.el('failure').hidden, true);
  assert.equal(ui.el('done').hidden, true);
  assert.equal(ui.el('step2').attributes.get('aria-current'), 'step');
  assert.equal(ui.focused(), 'state');
  ui.fire('signin', 'click');
  assert.equal(ui.el('state').value, 'signin');
  assert.match(ui.el('status').textContent, /Başka sayfa açılmıyor/);
  assert.equal(ui.el('done').hidden, true);
});

test('failed binding shows only the error and refocuses a visible control', () => {
  const ui = simulatedOnboarding();
  ui.fire('installed', 'click');
  ui.fire('bind', 'click');
  assert.equal(ui.el('state').value, 'error');
  assert.equal(ui.el('failure').hidden, false);
  assert.equal(ui.el('done').hidden, true);
  assert.match(ui.el('status').textContent, /Örnek hata/);
  assert.match(ui.el('step2').textContent, /örnek hata/);
  assert.equal(ui.focused(), 'state');
});

test('retry clears the error without falsely reporting success', () => {
  const ui = simulatedOnboarding();
  ui.fire('installed', 'click');
  ui.fire('bind', 'click');
  ui.fire('retry', 'click');
  assert.equal(ui.el('state').value, 'signin');
  assert.equal(ui.el('failure').hidden, true);
  assert.equal(ui.el('connect').hidden, false);
  assert.equal(ui.el('done').hidden, true);
  assert.match(ui.el('status').textContent, /giriş ekranı bekleniyor/);
  assert.equal(ui.focused(), 'state');
  ui.fire('bind', 'click');
  assert.equal(ui.el('failure').hidden, false, 'subsequent failure is still visible');
});

test('all six select fixtures reset stale panels and loading state', () => {
  const ui = simulatedOnboarding();
  for (const state of ['success', 'error', 'loading', 'start', 'installed', 'signin']) {
    ui.choose(state);
    assert.equal(ui.el('state').value, state);
    assert.notEqual(ui.el('status').textContent, '');
    assert.equal(ui.el('done').hidden, state !== 'success');
    assert.equal(ui.el('failure').hidden, state !== 'error');
    assert.equal(ui.el('download').disabled, state === 'loading');
    assert.equal(ui.el('connect').hidden, !['installed', 'signin', 'error', 'success'].includes(state));
    assert.equal(ui.el('step2').attributes.get('aria-current') === 'step',
      ['installed', 'signin', 'error', 'success'].includes(state));
  }
});

test('quota fixture distinguishes current monthly units from inactive daily proposal', () => {
  assert.match(quota, /Free · Aylık kullanım/);
  assert.match(quota, /200 sıradan × 1 \+ 15 skill × 5 = 275/);
  assert.match(quota, /725 ağırlıklı birim kaldı/);
  assert.match(quota, /01–31 Ekim 2026 UTC/);
  assert.match(quota, /Reset: 1 Kasım 2026 00:00 UTC/);
  assert.match(quota, /ÖNERİ \/ ETKİN DEĞİL: Free 1\.000, Plus 5\.000, Pro 10\.000/);
  assert.match(quota, /Billing kapalıdır/);
  assert.match(quota, /UNKNOWN/);
  assert.match(quota, /<progress value="275" max="1000" aria-label="[^"]+">/);
  assert.match(quota, /<progress value="1000" max="1000" aria-label="[^"]+">/);
});
