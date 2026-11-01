import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALE_METRIC_NAMES,
  parseScaleTransportMetricRows,
} from '../../../src/ops/scale-transport-metrics.js';

const row = (name: string, events: unknown, bytes: unknown) => ({
  name, events, bytes, eventsUnit: 'count', bytesUnit: 'bytes',
});

test('T-104 absent telemetry remains UNKNOWN rather than claiming a measured zero', () => {
  const parsed = parseScaleTransportMetricRows([]);
  assert.deepEqual(Object.keys(parsed), [...SCALE_METRIC_NAMES]);
  for (const name of SCALE_METRIC_NAMES) {
    assert.deepEqual(parsed[name], {classification: 'UNKNOWN', events: null, bytes: null});
  }
});

test('T-104 one missing field makes the entire sample UNKNOWN', () => {
  const parsed = parseScaleTransportMetricRows([
    row('agent.connections', 0, 0),
    row('agent.rx_frames', 1, undefined),
    row('agent.tx_frames', null, 100),
  ]);
  assert.deepEqual(parsed['agent.connections'], {classification: 'OBSERVED', events: 0, bytes: 0});
  assert.deepEqual(parsed['agent.rx_frames'], {classification: 'UNKNOWN', events: null, bytes: null});
  assert.deepEqual(parsed['agent.tx_frames'], {classification: 'UNKNOWN', events: null, bytes: null});
  assert.equal(parsed['agent.reconnects'].classification, 'UNKNOWN');
});

test('T-105 duplicate, unknown and ambiguous metric names are rejected', () => {
  const example = row('relay.connections', 1, 0);
  assert.throws(() => parseScaleTransportMetricRows([example, example]), /Duplicate/);
  assert.throws(() => parseScaleTransportMetricRows([row('relay.connections ', 1, 0)]), /Unknown/);
  assert.throws(() => parseScaleTransportMetricRows([row('relay.connection', 1, 0)]), /Unknown/);
  assert.throws(() => parseScaleTransportMetricRows([row('__proto__', 1, 0)]), /Unknown/);
});

test('T-105 mixed units and invalid counters fail closed', () => {
  const example = row('agent.rx_frames', 1, 200);
  for (const alteration of [
    {eventsUnit: 'bytes'}, {bytesUnit: 'count'}, {eventsUnit: undefined},
    {events: -1}, {events: Infinity}, {bytes: Number.NaN},
    {bytes: 1.5}, {events: Number.MAX_SAFE_INTEGER + 1},
  ]) {
    assert.throws(() => parseScaleTransportMetricRows([{...example, ...alteration}]));
  }
  assert.throws(() => parseScaleTransportMetricRows({}), /array/);
});

test('T-106 source-row order cannot reorder the canonical serialized report', () => {
  const a = row('relay.auth_denials', 1, 0);
  const b = row('agent.connections', 3, 0);
  const first = parseScaleTransportMetricRows([a, b]);
  const second = parseScaleTransportMetricRows([b, a]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first), [...SCALE_METRIC_NAMES]);
  assert.deepEqual(first['relay.auth_denials'], {
    classification: 'OBSERVED', events: 1, bytes: 0,
  });
});
