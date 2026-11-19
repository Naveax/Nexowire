import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// W-581: isolated source-level proof, NOT a browser, Agent, Hub or auth test.
// Run against the owner PR checkout with:
// K01_CONNECT_REF=<owner SHA> K01_EXPECT_BLOB=<web/connect.js blob SHA> \
//   node --test test/delegated/k01/p013-null-pairing.test.mjs
const source = process.env.K01_CONNECT_SOURCE_PATH
  ? readFileSync(process.env.K01_CONNECT_SOURCE_PATH, 'utf8')
  : process.env.K01_CONNECT_REF
    ? execFileSync('git', ['show', `${process.env.K01_CONNECT_REF}:web/connect.js`], { encoding: 'utf8' })
    : readFileSync('web/connect.js', 'utf8');
const blob = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
if (process.env.K01_EXPECT_BLOB) {
  assert.equal(blob, process.env.K01_EXPECT_BLOB, 'owner source SHA changed: refresh evidence before asserting');
}

function excerpt(start, stop) {
  assert.equal(source.split(start).length, 2, `expected unique source anchor: ${start}`);
  const begin = source.indexOf(start);
  const end = source.indexOf(stop, begin + start.length);
  assert.ok(end > begin, `missing ending source anchor: ${stop}`);
  return source.slice(begin, end);
}
const deny403 = excerpt("if (pairing.status === 403) {", "throw new Error('Bağlantı hazırlanamadı.');");
const success200 = excerpt('const body = await pairing.json();', "callback.searchParams.set('state'");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function run403(block, jsonBody) {
  const fn = new AsyncFunction('pairing', `
    let retryable = true;
    const body = await pairing.json().catch(() => ({}));
    try { ${block} }
    catch (error) { return { name: error.name, message: error.message, retryable }; }
    return { name: 'NO_ERROR', retryable };
  `);
  return fn({ status: 403, json: async () => jsonBody });
}
async function run200(block, jsonBody) {
  const fn = new AsyncFunction('pairing', `
    try { ${block} return { name: 'OK' }; }
    catch (error) { return { name: error.name, message: error.message }; }
  `);
  return fn({ json: async () => jsonBody });
}
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'owner source differs; no silent candidate substitution');
  return text.replace(before, after);
}

// Keep this source test useful both BEFORE and AFTER the owner fix.
// A repaired owner source must not fail only because it no longer reproduces RED.
test('W-581 #539: 403 JSON-null source and null-safe candidate preserve quota denial', async () => {
  const actual = await run403(deny403, null);
  assert.equal(actual.retryable, false);
  const candidate = actual.name === 'TypeError'
    ? replaceOnce(deny403, "body.error === 'DEVICE_LIMIT_REACHED'", "body?.error === 'DEVICE_LIMIT_REACHED'")
    : deny403;
  if (actual.name !== 'TypeError') {
    assert.equal(actual.message, 'Bu cihaz bu hesaba bağlanamadı.', 'owner behavior changed unexpectedly');
  }
  assert.equal((await run403(candidate, null)).message, 'Bu cihaz bu hesaba bağlanamadı.');
  assert.equal((await run403(candidate, {})).message, 'Bu cihaz bu hesaba bağlanamadı.');
  assert.equal((await run403(candidate, { error: 'DEVICE_LIMIT_REACHED' })).message, 'Bu hesap için cihaz limiti dolu.');
});

test('W-581 #485: 200 JSON-null source and null-safe candidate preserve valid pairing', async () => {
  const actual = await run200(success200, null);
  const candidate = actual.name === 'TypeError'
    ? replaceOnce(success200,
      "typeof body.pairingId !== 'string' ||", "!body || typeof body.pairingId !== 'string' ||")
    : success200;
  if (actual.name !== 'TypeError') {
    assert.equal(actual.message, 'Bağlantı cevabı geçersiz.', 'owner behavior changed unexpectedly');
  }
  assert.equal((await run200(candidate, null)).message, 'Bağlantı cevabı geçersiz.');
  assert.equal((await run200(candidate, {})).message, 'Bağlantı cevabı geçersiz.');
  assert.equal((await run200(candidate, { pairingId: 'pair', token: 'token' })).name, 'OK');
});

// Enable after owner fixes, so known-unfixed cases are never called PASS.
test('W-581 owner acceptance: null 403 remains a specific terminal denial', {
  skip: process.env.K01_REQUIRE_NULL_FIX !== '1' && 'owner source still RED',
}, async () => {
  const result = await run403(deny403, null);
  assert.equal(result.message, 'Bu cihaz bu hesaba bağlanamadı.');
  assert.equal(result.retryable, false);
});
test('W-581 owner acceptance: null 200 is malformed pairing, not an exception leak', {
  skip: process.env.K01_REQUIRE_NULL_FIX !== '1' && 'owner source still RED',
}, async () => {
  const result = await run200(success200, null);
  assert.equal(result.message, 'Bağlantı cevabı geçersiz.');
});
