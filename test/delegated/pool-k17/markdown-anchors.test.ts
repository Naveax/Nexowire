import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditSamePageAnchors,
  indexHeadingAnchors,
} from './markdown-anchors.js';

test('T-244: duplicate headings receive stable unique fragments', () => {
  const markdown = [
    '# Install',
    '## Install',
    '## Install',
    '## Install-1',
    '## Install',
  ].join('\n');
  assert.deepEqual(indexHeadingAnchors(markdown).map((item) => item.anchor), [
    'install', 'install-1', 'install-2', 'install-1-1', 'install-3',
  ]);
  assert.deepEqual(indexHeadingAnchors(markdown), indexHeadingAnchors(markdown));
});

test('T-244: exact duplicate heading suffix is required by same-page links', () => {
  const valid = [
    '# Setup',
    '## Setup',
    '[first](#setup) [second](#setup-1)',
  ].join('\n');
  assert.deepEqual(auditSamePageAnchors(valid), []);
  assert.deepEqual(auditSamePageAnchors(`${valid}\n[third](#setup-2)`), [
    { line: 4, kind: 'missing-target', target: 'setup-2' },
  ]);
});

test('T-244: duplicates in fenced examples do not reserve anchors', () => {
  const markdown = [
    '# Overview',
    '```md',
    '# Overview',
    '[wrong](#missing)',
    '```',
    '~~~markdown',
    '# Overview',
    '~~~',
    '[correct](#overview)',
    '## Overview',
    '[second](#overview-1)',
  ].join('\n');
  assert.deepEqual(indexHeadingAnchors(markdown).map((item) => item.anchor), [
    'overview', 'overview-1',
  ]);
  assert.deepEqual(auditSamePageAnchors(markdown), []);
});

test('T-244: explicit HTML duplicate IDs and malformed anchors are reported', () => {
  const markdown = [
    '# Intro',
    '<a id="intro"></a>',
    '<a name="custom"></a>',
    '<a id="custom"></a>',
    '[valid](#custom)',
    '[bad](#nope)',
    '[bad encoding](#%ZZ)',
  ].join('\n');
  assert.deepEqual(auditSamePageAnchors(markdown), [
    { line: 2, kind: 'duplicate-id', target: 'intro' },
    { line: 4, kind: 'duplicate-id', target: 'custom' },
    { line: 6, kind: 'missing-target', target: 'nope' },
    { line: 7, kind: 'missing-target', target: '%ZZ' },
  ]);
});

test('T-244: Unicode headings and inline decoration remain addressable', () => {
  const markdown = [
    '# **Bağlantı** ve _Giriş_',
    '## [Cihaz seçimi](https://example.invalid)',
    '[a](#bağlantı-ve-giriş) [b](#cihaz-seçimi)',
  ].join('\n');
  assert.deepEqual(indexHeadingAnchors(markdown).map((item) => item.anchor), [
    'bağlantı-ve-giriş', 'cihaz-seçimi',
  ]);
  assert.deepEqual(auditSamePageAnchors(markdown), []);
});
