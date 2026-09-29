import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearerFromHeader,
  matchesAnyToken,
  matchesBearerHeader,
  parseTokenList,
} from '../src/security/tokens.js';

test('token lists trim, deduplicate, and preserve rotation order', () => {
  assert.deepEqual(
    parseTokenList(
      'current, old ',
      'old,next,, current',
      undefined,
    ),
    ['current', 'old', 'next'],
  );
});

test('bearer parsing is scheme-case insensitive and whitespace tolerant', () => {
  assert.equal(bearerFromHeader('Bearer abc'), 'abc');
  assert.equal(bearerFromHeader('bearer   abc  '), 'abc');
  assert.equal(bearerFromHeader('Basic abc'), undefined);
  assert.equal(bearerFromHeader(undefined), undefined);
});

test('constant-time digest matching accepts any configured rotation token', () => {
  const tokens = ['old-secret', 'current-secret', 'next-secret'];
  assert.equal(matchesAnyToken('old-secret', tokens), true);
  assert.equal(matchesAnyToken('current-secret', tokens), true);
  assert.equal(matchesAnyToken('next-secret', tokens), true);
  assert.equal(matchesAnyToken('wrong-secret', tokens), false);
  assert.equal(matchesAnyToken(undefined, tokens), false);
  assert.equal(matchesAnyToken('anything', []), false);

  assert.equal(
    matchesBearerHeader('Bearer current-secret', tokens),
    true,
  );
  assert.equal(
    matchesBearerHeader('Bearer wrong-secret', tokens),
    false,
  );
});
