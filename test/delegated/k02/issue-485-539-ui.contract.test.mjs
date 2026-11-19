import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Issue #485 / #539 R11: read-only acceptance contracts for the pending
// coordinated UI integration (#1068). No production CSS/JS behavior is changed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const css = readFileSync(process.env.NEXOWIRE_CSS_PATH
  ? resolve(process.env.NEXOWIRE_CSS_PATH) : resolve(root, 'web/styles.css'), 'utf8');
const legacyBlob = 'd45d9445ba84361648f2544db243ff975b9ab21b';
const blobSha = createHash('sha1').update(`blob ${Buffer.byteLength(css)}\0`).update(css).digest('hex');
const preIntegration = blobSha === legacyBlob;

function blocks(input) {
  const out = [];
  for (let pos = 0; pos < input.length;) {
    const open = input.indexOf('{', pos);
    if (open < 0) {
      assert.equal(input.slice(pos).trim(), '', 'unexpected trailing CSS text');
      break;
    }
    const header = input.slice(pos, open).trim();
    let depth = 1, end = open + 1;
    while (end < input.length && depth) {
      if (input[end] === '{') depth++;
      if (input[end] === '}') depth--;
      end++;
    }
    assert.equal(depth, 0, `unclosed CSS rule: ${header}`);
    out.push({ header, body: input.slice(open + 1, end - 1) });
    pos = end;
  }
  return out;
}

function parse(input) {
  const rules = [];
  const clean = input.replace(/\/\*[\s\S]*?\*\//g, '');
  function visit(source, maxWidth = null, feature = null) {
    for (const { header, body } of blocks(source)) {
      if (header.startsWith('@media')) {
        const w = /^@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)$/.exec(header);
        const f = /^@media\s*\(\s*(forced-colors|prefers-reduced-motion)\s*:\s*(active|reduce)\s*\)$/.exec(header);
        if (w) visit(body, Math.min(maxWidth ?? Infinity, Number(w[1])), feature);
        else if (f) visit(body, maxWidth, `${f[1]}:${f[2]}`);
        continue;
      }
      if (header.startsWith('@')) continue;
      const declarations = {};
      for (const part of body.split(';')) {
        const colon = part.indexOf(':');
        if (colon !== -1) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      rules.push({ selectors: header.split(',').map(x => x.trim()), declarations, maxWidth, feature });
    }
  }
  visit(clean);
  return rules;
}

function value(rules, selector, property, width, features = []) {
  let result;
  for (const rule of rules) {
    if ((rule.maxWidth === null || width <= rule.maxWidth) &&
        (!rule.feature || features.includes(rule.feature)) &&
        rule.selectors.includes(selector) && rule.declarations[property] !== undefined) {
      result = rule.declarations[property];
    }
  }
  return result;
}

const rules = parse(css);
const pending = preIntegration && process.env.NEXOWIRE_REQUIRE_UI_INTEGRATION !== '1';
const skip = pending ? 'legacy main CSS (blob d45d944…); #1068 has not entered main' : false;

test('legacy source is never silently mistaken for the integrated responsive CSS', () => {
  assert.equal(preIntegration, blobSha === legacyBlob);
  if (preIntegration) {
    assert.notEqual(value(rules, '.topbar', 'flex-wrap', 320), 'wrap');
  }
});

test('320/375/768px: device and error surfaces never depend on two desktop columns', { skip }, () => {
  for (const width of [320, 375, 768]) {
    assert.equal(value(rules, '.device-list', 'grid-template-columns', width), '1fr');
    assert.equal(value(rules, '.utility-grid', 'grid-template-columns', width), '1fr');
    assert.equal(value(rules, '.device', 'min-width', width), '0');
  }
  for (const width of [320, 375]) {
    assert.equal(value(rules, '.topbar-right', 'flex-wrap', width), 'wrap');
    assert.equal(value(rules, '.connect-title-row', 'flex-wrap', width), 'wrap');
  }
  const broken = parse(css.replace(/(\.device-list\s*\{\s*)grid-template-columns:1fr;/, '$1'));
  assert.notEqual(value(broken, '.device-list', 'grid-template-columns', 768), '1fr');
});

test('long operation ID, Unicode device name and URL have separate wrap guards', { skip }, () => {
  const fixture = readFileSync(resolve(root, 'test/delegated/k02/overflow-fixtures.html'), 'utf8');
  assert.match(fixture, /id="unicode-device"/);
  assert.match(fixture, /İŞİİŞİ-🖥️/u);
  assert.match(fixture, /id="long-url">https:\/\/invalid\.example\.test\/tenant\//);
  for (const width of [320, 375]) {
    for (const selector of ['.device-name', '.error-panel', '.bridge-live-status', '.device-header .status']) {
      assert.equal(value(rules, selector, 'overflow-wrap', width), 'anywhere', selector);
    }
    assert.equal(value(rules, '.device-header .status', 'white-space', width), 'normal');
  }
  const broken = parse(css.replace(/(\.device-header \.status\s*\{[^}]*?)overflow-wrap:anywhere;/, '$1'));
  assert.notEqual(value(broken, '.device-header .status', 'overflow-wrap', 375), 'anywhere');
});

test('high-contrast keyboard focus uses a forced-color system outline', { skip }, () => {
  for (const selector of ['button:focus-visible', 'select:focus-visible',
    'textarea:focus-visible', '.bridge-toggle:focus-visible']) {
    assert.equal(value(rules, selector, 'outline', 375, ['forced-colors:active']),
      '3px solid Highlight !important');
  }
  assert.equal(value(rules, 'button:focus-visible', 'outline-offset', 375), '3px');
});

test('zoom CSS-width proxies keep 640px one-column and 320px mobile wrap', { skip }, () => {
  // Approximate CSS widths for 1280px / 200% and / 400%; real browser zoom NOT_RUN.
  assert.equal(value(rules, '.device-list', 'grid-template-columns', 640), '1fr');
  assert.equal(value(rules, '.metrics', 'grid-template-columns', 640), 'repeat(3,minmax(0,1fr))');
  assert.equal(value(rules, '.device-list', 'grid-template-columns', 320), '1fr');
  assert.equal(value(rules, '.metrics', 'grid-template-columns', 320), 'repeat(2,minmax(0,1fr))');
  assert.equal(value(rules, '.topbar', 'flex-wrap', 320), 'wrap');
});

test('motion preference disables visual spinner but does not erase busy text', { skip }, () => {
  const spinner = '#approve[data-busy="true"]::after';
  const fixture = readFileSync(resolve(root, 'test/delegated/k02/overflow-fixtures.html'), 'utf8');
  assert.match(fixture, /data-busy="true"[^>]+disabled>BAĞLANIYOR/);
  assert.equal(value(rules, spinner, 'animation', 375), 'button-spin .7s linear infinite');
  assert.equal(value(rules, '*::after', 'animation', 375, ['prefers-reduced-motion:reduce']), 'none !important');
  assert.equal(value(rules, spinner, 'border-right-color', 375, ['prefers-reduced-motion:reduce']), 'currentColor');
});

// These are static source/fixture assertions, not browser screenshots, actual
// screen reader behavior, physical Windows acceptance or issue closure.
