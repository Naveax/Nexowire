import test from 'node:test';
import assert from 'node:assert/strict';

test('an actually executed assertion', () => {
  assert.equal(2 + 2, 4);
});
test('platform-specific assertion did not run', { skip: 'requires another OS' }, () => {
  assert.fail('should never run on this platform');
});
