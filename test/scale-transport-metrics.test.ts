import test from 'node:test';
import assert from 'node:assert/strict';
import { ScaleTransportMetrics, safelyRecordScaleMetric } from '../src/ops/scale-transport-metrics.js';

test('S1 metrics keep only bounded numeric aggregates and isolated snapshots', () => {
  const metrics = new ScaleTransportMetrics();
  metrics.record('agent.connections');
  metrics.record('agent.rx_frames', 125);
  metrics.record('agent.rx_frames', 75);
  metrics.record('agent.resumed_requests', 0, 3);
  const first = metrics.snapshot();
  assert.equal(first['agent.connections'].events, 1);
  assert.deepEqual(first['agent.rx_frames'], {events:2,bytes:200});
  assert.equal(first['agent.resumed_requests'].events, 3);
  assert.equal(first['agent.rejected_requests'].events, 0);
  assert.equal(Object.keys(first).length, 14);
  // Snapshot must not mutate counters, even if a caller modifies its copy.
  (first['agent.rx_frames'] as {bytes:number}).bytes = 999;
  assert.equal(metrics.snapshot()['agent.rx_frames'].bytes, 200);
  assert.equal(JSON.stringify(metrics.snapshot()).includes('deviceId'), false);
});

test('S1 metrics fail closed on invalid numeric input and observer errors do not break traffic', () => {
  const metrics = new ScaleTransportMetrics();
  for (const bytes of [Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(() => metrics.record('relay.upstream_frames', bytes));
  }
  assert.throws(() => metrics.record('agent.rx_frames', 0, -1));
  metrics.record('agent.rx_frames', Number.MAX_SAFE_INTEGER);
  assert.throws(() => metrics.record('agent.rx_frames', 1));
  assert.doesNotThrow(() => safelyRecordScaleMetric(metrics,'agent.rx_frames',1));
  assert.doesNotThrow(() => safelyRecordScaleMetric(undefined,'agent.rx_frames',1));
  assert.equal(metrics.snapshot()['agent.rx_frames'].bytes, Number.MAX_SAFE_INTEGER);
});
