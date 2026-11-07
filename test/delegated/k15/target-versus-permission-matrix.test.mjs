import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveOwnerDeviceTarget} from '../../../src/product/device-target-resolution.ts';

// P004 pool T-394: this pure target-resolver is NOT MCP tool admission.
// A "selected" return value represents a candidate only. Authenticated
// scope, online state, Agent receipt and physical grant are separate gates.
const A = {id: 'stable-a', name: 'Ortak PC', online: true, folderId: 'office'};
const B = {id: 'stable-b', name: 'Ortak PC', online: true, folderId: 'office'};
const C = {id: 'stable-c', name: 'Depo PC', online: false, folderId: 'warehouse'};
const folders = [
  {id: 'office', name: 'Ofis'},
  {id: 'warehouse', name: 'Depo'},
];

test('no registered device does not produce a target even with auto preference', () => {
  assert.equal(resolveOwnerDeviceTarget([], folders, {}, false).status, 'no_devices');
  assert.equal(resolveOwnerDeviceTarget([], folders, {}, true).status, 'no_devices');
});

test('one online device without explicit target is not implicitly selected by default', () => {
  const response = resolveOwnerDeviceTarget([A], folders, {}, false);
  assert.equal(response.status, 'selection_required');
  assert.equal(response.reason, 'explicit-selection-required');
  assert.equal(response.devices[0].id, A.id);
  const optIn = resolveOwnerDeviceTarget([A], folders, {}, true);
  assert.equal(optIn.status, 'selected');
  assert.equal(optIn.reason, 'only-device');
});

test('same names do not silently select a random device', () => {
  const named = resolveOwnerDeviceTarget([A, B], folders, {deviceName: 'Ortak PC'}, true);
  assert.equal(named.status, 'selection_required');
  assert.equal(named.reason, 'ambiguous-device');
  assert.equal(named.devices.length, 2);
  const withoutName = resolveOwnerDeviceTarget([A, B], folders, {}, true);
  assert.equal(withoutName.status, 'selection_required');
  assert.equal(withoutName.reason, 'multiple-devices');
});

test('normalization-equivalent Unicode names still require unambiguous identity', () => {
  const a = {...A, name: 'ＭＡＩＮ PC'};
  const b = {...B, name: 'main pc'};
  const result = resolveOwnerDeviceTarget([a, b], folders, {deviceName: 'Main PC'});
  assert.equal(result.status, 'selection_required');
  assert.equal(result.reason, 'ambiguous-device');
});

test('explicit stable ID distinguishes identical visible labels regardless of order', () => {
  for (const devices of [[A, B], [B, A]]) {
    const selected = resolveOwnerDeviceTarget(devices, folders, {deviceId: B.id});
    assert.equal(selected.status, 'selected');
    assert.equal(selected.reason, 'explicit-device');
    assert.equal(selected.device.id, B.id);
  }
});

test('one online plus a different offline registered device never implies unique owner target', () => {
  const result = resolveOwnerDeviceTarget([A, C], folders, {}, true);
  assert.equal(result.status, 'selection_required');
  assert.equal(result.reason, 'multiple-devices');
  assert.deepEqual(result.devices.map(d => d.id).sort(), [A.id, C.id]);
});

test('offline explicit ID is only a resolver candidate, not a grant or dispatch proof', () => {
  const result = resolveOwnerDeviceTarget([C], folders, {deviceId: C.id}, false);
  assert.equal(result.status, 'selected');
  assert.equal(result.device.online, false);
  assert.equal('authorization' in result, false);
  assert.equal('brokerGrant' in result, false);
  assert.equal('operationReceipt' in result, false);
});

test('folder limits the candidates and does not authorize a foreign ID', () => {
  assert.throws(() => resolveOwnerDeviceTarget([A, C], folders,
    {deviceId: C.id, folderId: 'office'}, true), /DEVICE_NOT_FOUND/);
  assert.throws(() => resolveOwnerDeviceTarget([A], folders,
    {deviceId: 'unregistered'}, true), /DEVICE_NOT_FOUND/);
  const correct = resolveOwnerDeviceTarget([A, C], folders, {folderId: 'office'}, false);
  assert.equal(correct.status, 'selection_required');
});

test('two identically named folders cannot silently scope a selection', () => {
  const sameNamedFolders = [
    {id: 'floor-1', name: 'Ofis'},
    {id: 'floor-2', name: 'Ｏｆｉｓ'},
  ];
  const result = resolveOwnerDeviceTarget([
    {...A, folderId: 'floor-1'},
    {...B, folderId: 'floor-2'},
  ], sameNamedFolders, {folderName: 'ofis'}, true);
  assert.equal(result.status, 'selection_required');
  assert.equal(result.reason, 'ambiguous-folder');
  assert.equal(result.folders.length, 2);
});

test('contradictory device ID/name and folder ID/name are rejected explicitly', () => {
  assert.throws(() => resolveOwnerDeviceTarget([A, C], folders,
    {deviceId: A.id, deviceName: C.name}), /DEVICE_NOT_FOUND/);
  assert.throws(() => resolveOwnerDeviceTarget([A, C], folders,
    {folderId: 'office', folderName: 'Depo'}), /FOLDER_NOT_FOUND/);
});

test('single scoped device requires opt-in before implicit folder selection', () => {
  const query = {folderId: 'warehouse'};
  const blocked = resolveOwnerDeviceTarget([A, C], folders, query, false);
  assert.equal(blocked.status, 'selection_required');
  assert.equal(blocked.reason, 'explicit-selection-required');
  assert.deepEqual(blocked.devices.map(d => d.id), [C.id]);
  const optIn = resolveOwnerDeviceTarget([A, C], folders, query, true);
  assert.equal(optIn.status, 'selected');
  assert.equal(optIn.reason, 'one-in-folder');
  assert.equal(optIn.device.id, C.id);
  assert.equal(optIn.device.online, false, 'routing selection is not online admission');
});

test('unknown folder and empty known folder cannot become a default target', () => {
  assert.throws(() => resolveOwnerDeviceTarget([A], folders,
    {folderId: 'missing'}, true), /FOLDER_NOT_FOUND/);
  const empty = resolveOwnerDeviceTarget([A], folders,
    {folderId: 'warehouse'}, true);
  assert.equal(empty.status, 'empty_folder');
  assert.deepEqual(empty.devices, []);
});

test('MCP tool admission separately requires online owner uniqueness and credential scope', () => {
  // Read-only source invariant: do not equate the pure resolver's candidate
  // with a tool authorization result or bypass owner checks in the UI.
  const source = readFileSync(new URL('../../../src/mcp/create-server.ts', import.meta.url), 'utf8');
  assert.match(source, /ownerAuto && ownerIds\.length === 1 && onlineIds\.has\(ownerIds\[0\]!\)/);
  assert.match(source, /hasMcpTargetRestrictions\(ctx\.toolAuthorization\)/);
  assert.match(source, /DEVICE_SELECTION_REQUIRED: Call devices_list/);
});
