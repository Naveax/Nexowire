import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  compareScaleMetricReports,
  parseScaleTransportMetricRows,
  safelyParseScaleTransportMetricRows,
  SCALE_METRIC_NAMES,
} from '../../../src/ops/scale-transport-metrics.js';

type TelemetryFixture={schema:string;origin:string;
  samples:Array<{sequence:number;rows:unknown[]}>};
const fixture=JSON.parse(
  readFileSync(new URL('./synthetic-telemetry.json',import.meta.url),'utf8'),
) as TelemetryFixture;

test('T-139 fixture is ordered, entirely synthetic and has repeatable counter rows',()=>{
  assert.equal(fixture.schema,'nexowire-k18-offline-telemetry-fixture-v1');
  assert.equal(fixture.origin,'SYNTHETIC_NO_REAL_ACCOUNTS_OR_DEVICES');
  assert.deepEqual(fixture.samples.map(s=>s.sequence),[1,2,3]);
  for(const sample of fixture.samples){
    const report=parseScaleTransportMetricRows(sample.rows);
    assert.equal(report['agent.rx_frames'].classification,'OBSERVED');
    assert.equal(report['relay.auth_denials'].classification,'OBSERVED');
    assert.equal(report['relay.auth_denials'].events,0);
    assert.equal(report['agent.tx_frames'].classification,'UNKNOWN');
  }
});

test('T-221 monotonic and decreasing counter samples are distinguished',()=>{
  const [first,second,third]=fixture.samples.map(s=>parseScaleTransportMetricRows(s.rows));
  const increasing=compareScaleMetricReports(first!,second!);
  assert.equal(increasing['agent.rx_frames'],'NON_DECREASING');
  assert.equal(increasing['relay.auth_denials'],'NON_DECREASING');
  assert.equal(increasing['agent.tx_frames'],'UNKNOWN');
  const decreasing=compareScaleMetricReports(second!,third!);
  assert.equal(decreasing['agent.rx_frames'],'DECREASED');
  assert.equal(decreasing['relay.auth_denials'],'NON_DECREASING');
  assert.equal(decreasing['agent.tx_frames'],'UNKNOWN');
});

test('T-221 absent prior sample is UNKNOWN, never interpreted as a decrease',()=>{
  const observed=parseScaleTransportMetricRows(fixture.samples[0]!.rows);
  const missing=parseScaleTransportMetricRows([]);
  assert.equal(compareScaleMetricReports(missing,observed)['agent.rx_frames'],'UNKNOWN');
  assert.equal(compareScaleMetricReports(observed,missing)['agent.rx_frames'],'UNKNOWN');
});

test('T-222 mixed or missing units keep the complete best-effort report UNKNOWN',()=>{
  const valid=fixture.samples[0]!.rows[0] as Record<string,unknown>;
  for(const invalid of [
    {...valid,bytesUnit:'count'},
    {...valid,eventsUnit:'bytes'},
    {...valid,events:'1'},
    {...valid,bytes:Number.POSITIVE_INFINITY},
  ]){
    assert.throws(()=>parseScaleTransportMetricRows([invalid]));
    const safe=safelyParseScaleTransportMetricRows([valid,invalid]);
    for(const name of SCALE_METRIC_NAMES){
      assert.equal(safe[name].classification,'UNKNOWN',name);
      assert.equal(safe[name].events,null);
      assert.equal(safe[name].bytes,null);
    }
  }
});
