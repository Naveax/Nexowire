import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditPageMeta } from './check-meta.mjs';

const root = new URL('../../../', import.meta.url);
const fixture = (body, { lang = 'tr', title = 'Nexowire' } = {}) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body>${body}</body></html>`;

test('T-125: all four current web pages retain lang, title, UTF-8 and zoom-friendly viewport', () => {
  for (const page of ['web/index.html', 'web/connect.html', 'web/admin.html',
    'web/custom-usage-consent-preview.html']) {
    assert.deepEqual(auditPageMeta(readFileSync(new URL(page, root), 'utf8')), [], page);
  }
});

test('T-125: empty or malformed lang is rejected', () => {
  assert.ok(auditPageMeta(fixture('', { lang: '' })).includes('missing-or-invalid-lang'));
  assert.ok(auditPageMeta(fixture('', { lang: 'INVALID_LANG!' })).includes('missing-or-invalid-lang'));
  assert.deepEqual(auditPageMeta(fixture('', { lang: 'tr-TR' })), []);
});

test('T-125: empty and duplicated document titles are rejected', () => {
  assert.ok(auditPageMeta(fixture('', { title: ' ' })).includes('missing-or-duplicate-title'));
  const duplicated = fixture('').replace('</head>', '<title>Tekrar</title></head>');
  assert.ok(auditPageMeta(duplicated).includes('missing-or-duplicate-title'));
});

test('T-125: missing and duplicate UTF-8 declarations are rejected', () => {
  assert.ok(auditPageMeta(fixture('').replace('<meta charset="utf-8">', ''))
    .includes('missing-or-duplicate-utf8'));
  assert.ok(auditPageMeta(fixture('').replace('</head>', '<meta charset="utf-8"></head>'))
    .includes('missing-or-duplicate-utf8'));
});

test('T-125: missing/duplicate mobile viewport is rejected', () => {
  assert.ok(auditPageMeta(fixture('').replace(/<meta name="viewport"[^>]+>/, ''))
    .includes('missing-or-duplicate-viewport'));
  assert.ok(auditPageMeta(fixture('').replace('</head>',
    '<meta name="viewport" content="width=device-width"></head>'))
    .includes('missing-or-duplicate-viewport'));
});

test('T-125: user-scalable=no and maximum-scale=1 fail; maximum-scale=5 is allowed', () => {
  const viewport = 'width=device-width,initial-scale=1';
  assert.ok(auditPageMeta(fixture('').replace(viewport, `${viewport},user-scalable=no`))
    .includes('zoom-restricted'));
  assert.ok(auditPageMeta(fixture('').replace(viewport, `${viewport},maximum-scale=1`))
    .includes('zoom-restricted'));
  assert.deepEqual(auditPageMeta(fixture('').replace(viewport, `${viewport},maximum-scale=5`)), []);
});

test('T-125: markup-like comments/scripts do not satisfy required metadata', () => {
  const html = '<html><head><!-- <meta charset="utf-8"> -->' +
    '<script>const x = "<title>Fake</title>";</script></head><body></body></html>';
  const result = auditPageMeta(html);
  for (const expected of ['missing-or-invalid-lang', 'missing-or-duplicate-title',
    'missing-or-duplicate-utf8', 'missing-or-duplicate-viewport']) {
    assert.ok(result.includes(expected), expected);
  }
});

test('T-125: missing head fails closed', () => {
  assert.ok(auditPageMeta('<html lang="tr"><body></body></html>').includes('missing-head'));
});
