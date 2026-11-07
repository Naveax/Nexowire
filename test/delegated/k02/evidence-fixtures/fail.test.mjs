import test from 'node:test';
import assert from 'node:assert/strict';

test('a completed process can fail an assertion', () => {
  assert.equal(2 + 2, 5);
});
