import assert from 'node:assert/strict';
import test from 'node:test';
import { inventory, inspectInventory, reportInventory, hashGitBlob, unverifiedLanes } from './issue780-evidence.mjs';

test('issue #780: four exact source blobs checked, all classified source-only', () => {
  const rows = inspectInventory();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.status), Array(4).fill('SOURCE_SURFACE_ONLY'));
  assert.equal(unverifiedLanes.length, 5);
});

test('Git blob SHA hashes file content, including byte count header', () => {
  assert.equal(hashGitBlob('test content\n'), 'd670460b4b4aece5915caf5c68d12f560a9fe3e4');
});

test('changed source fails provenance check instead of retaining stale positive status', () => {
  assert.throws(() => inspectInventory([{ ...inventory[0], blob: '0'.repeat(40) }]), /Main source changed/);
});

test('duplicate lane, traversal, missing evidence boundary all fail closed', () => {
  assert.throws(() => inspectInventory([inventory[0], inventory[0]]), /Duplicate/);
  assert.throws(() => inspectInventory([{ ...inventory[0], path: '../private' }]), /Invalid source/);
  assert.throws(() => inspectInventory([{ ...inventory[0], missingGate: '' }]), /Missing evidence boundary/);
});

test('feature inventory never promotes a file or skill to epic acceptance', () => {
  const report = reportInventory();
  assert.equal(report.split('\n').length, 9);
  assert.match(report, /Git API/);
  assert.match(report, /UNKNOWN/);
  assert.doesNotMatch(report, /DEPLOYED|ACCEPTED|CI_PASS/);
});
