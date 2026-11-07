import test from 'node:test';
import assert from 'node:assert/strict';

test('cross-platform assertion actually executes', () => {
  assert.equal(2 + 2, 4);
});
