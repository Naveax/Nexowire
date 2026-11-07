import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercises the real UI status mapping without opening a Hub, Agent, Broker,
// local port or GitHub account. Does not validate server-side command authority.
const source = readFileSync(new URL('../../../web/app.js', import.meta.url), 'utf8');
const bootstrapStart = source.indexOf("$('folder-filter').addEventListener('change'");
assert.ok(bootstrapStart > 0, 'UI bootstrap boundary');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function harness(states, { requestId = 'req-7', deviceId = 'device-7', mode = 'on' } = {}) {
  const history = [];
  const status = {
    get textContent() { return history.at(-1) ?? ''; },
    set textContent(value) { history.push(String(value)); },
  };
  const elements = new Map([
    ['.bridge-command-status', status],
    ['.bridge-apply-panel', { hidden: false }],
    ['.bridge-apply-phrase', { value: 'APPLY BRIDGE MODE', focus() {} }],
    ['.bridge-apply-toggle', { disabled: false }],
    ['.bridge-apply-approve', { disabled: false }],
  ]);
  const row = { querySelector: (selector) => {
    if (!elements.has(selector)) throw Error('unexpected selector: ' + selector);
    return elements.get(selector);
  } };
  const requests = [];
  let reloaded = 0;
  const queue = [response({ status: 'queued', requestId, expiresAt: '2099-01-01T00:00:00.000Z' }),
    ...states.map((state) => response({ requestId, deviceId, ...state }))];
  const context = vm.createContext({
    document: { getElementById: () => { throw Error('DOM was not expected'); } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (!queue.length) throw Error('poll exceeded bounded fixture');
      return queue.shift();
    },
    setTimeout: (callback) => callback(),
    Date, Set, Number, Math, Intl, encodeURIComponent,
  });
  vm.runInContext(source.slice(0, bootstrapStart), context, { filename: 'web/app.js' });
  vm.runInContext('load = async () => { globalThis.reloaded = (globalThis.reloaded || 0) + 1; }', context);
  return {
    history, row, elements, requests,
    run: async () => {
      context.__deviceId = deviceId;
      context.__mode = mode;
      context.__row = row;
      await vm.runInContext('applyDeviceBridgeMode(__deviceId, __mode, __row)', context);
      reloaded = context.reloaded ?? 0;
      return { reloaded };
    },
  };
}

test('queued/claimed never become success; only a matching applied result does', async () => {
  const h = harness([{ status: 'queued' }, { status: 'claimed' }, { status: 'applied' }]);
  const result = await h.run();
  assert.ok(h.history.some((line) => line.includes('kuyruğa alındı')));
  assert.ok(h.history.some((line) => /kuyrukta.*bekleniyor/i.test(line)));
  assert.ok(h.history.some((line) => /cihazda işleniyor.*bekleniyor/i.test(line)));
  assert.ok(h.history.at(-1).includes('İmzalı cihaz onayı alındı'));
  assert.equal(result.reloaded, 1);
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests.slice(1).every((r) => r.url.includes('requestId=req-7')));
});

test('failed, expired and unexpected terminal states never claim completion', async (t) => {
  for (const state of [
    { status: 'failed', failureCode: 'DISPATCH_REJECTED' },
    { status: 'expired' },
    { status: 'succeeded' }, // unsupported status must fail closed
  ]) {
    await t.test(state.status, async () => {
      const h = harness([state]);
      const { reloaded } = await h.run();
      assert.equal(reloaded, 0);
      assert.doesNotMatch(h.history.at(-1), /İmzalı cihaz onayı alındı/);
      if (state.status === 'failed') assert.match(h.history.at(-1), /DISPATCH_REJECTED/);
      if (state.status === 'expired') assert.match(h.history.at(-1), /uygulanmış sayılmaz/);
      if (state.status === 'succeeded') assert.match(h.history.at(-1), /Beklenmeyen cihaz komut durumu/);
    });
  }
});

test('wrong request or device identity stays unknown, not applied', async (t) => {
  for (const invalid of [{ requestId: 'other' }, { deviceId: 'other' }]) {
    await t.test(JSON.stringify(invalid), async () => {
      const h = harness([{ status: 'applied', ...invalid }]);
      const { reloaded } = await h.run();
      assert.equal(reloaded, 0);
      assert.match(h.history.at(-1), /komut yanıtı eşleşmiyor/);
    });
  }
});

test('missing confirmation phrase does not send any command', async () => {
  const h = harness([{ status: 'applied' }]);
  h.elements.get('.bridge-apply-phrase').value = 'WRONG';
  const { reloaded } = await h.run();
  assert.equal(reloaded, 0);
  assert.equal(h.requests.length, 0);
  assert.match(h.history.at(-1), /tam olarak APPLY BRIDGE MODE/);
});
