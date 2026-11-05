import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALE_METRIC_NAMES,
  ScaleTransportMetrics,
  safelyRecordScaleMetric,
} from '../../../src/ops/scale-transport-metrics.js';

test('T-103 empty transport report includes every named counter at zero', () => {
  const report = new ScaleTransportMetrics().snapshot();
  assert.deepEqual(Object.keys(report), [...SCALE_METRIC_NAMES]);
  for (const name of SCALE_METRIC_NAMES) {
    assert.deepEqual(report[name], {events: 0, bytes: 0}, name);
  }
  assert.equal(Object.keys(report).length, new Set(SCALE_METRIC_NAMES).size);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('T-103 a single observed event changes only its own report row', () => {
  const metrics = new ScaleTransportMetrics();
  const before = metrics.snapshot();
  metrics.record('relay.downstream_frames', 127);
  const after = metrics.snapshot();

  assert.deepEqual(after['relay.downstream_frames'], {events: 1, bytes: 127});
  for (const name of SCALE_METRIC_NAMES) {
    if (name !== 'relay.downstream_frames') {
      assert.deepEqual(after[name], {events: 0, bytes: 0}, name);
    }
  }
  assert.deepEqual(before['relay.downstream_frames'], {events: 0, bytes: 0});
  assert.equal(JSON.stringify(after).includes('payload'), false);
});

test('T-103 single sample with zero bytes remains a legitimate one-event observation', () => {
  const metrics = new ScaleTransportMetrics();
  safelyRecordScaleMetric(metrics, 'agent.heartbeat_pongs');
  assert.deepEqual(metrics.snapshot()['agent.heartbeat_pongs'], {events: 1, bytes: 0});
  assert.deepEqual(metrics.snapshot()['agent.heartbeat_pings'], {events: 0, bytes: 0});
});

test('T-103 invalid single sample cannot contaminate subsequent report', () => {
  const metrics = new ScaleTransportMetrics();
  assert.throws(() => metrics.record('agent.rx_frames', Number.NaN));
  assert.throws(() => metrics.record('agent.rx_frames', -1));
  assert.deepEqual(metrics.snapshot()['agent.rx_frames'], {events: 0, bytes: 0});
  metrics.record('agent.rx_frames', 4);
  assert.deepEqual(metrics.snapshot()['agent.rx_frames'], {events: 1, bytes: 4});
});
