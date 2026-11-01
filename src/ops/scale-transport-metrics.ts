// Optional, payload-free in-memory S1 connection metrics. Not a billing ledger.
export const SCALE_METRIC_NAMES = [
  'agent.connections', 'agent.disconnections',
  'agent.rx_frames', 'agent.tx_frames',
  'agent.resumed_requests', 'agent.rejected_requests',
  'agent.reconnects', 'agent.heartbeat_pings', 'agent.heartbeat_pongs',
  'agent.ack_responses',
  'relay.connections', 'relay.upstream_frames',
  'relay.downstream_frames', 'relay.auth_denials',
] as const;
export type ScaleMetricName = typeof SCALE_METRIC_NAMES[number];
export type ScaleMetricSnapshot = Readonly<Record<ScaleMetricName, {readonly events:number;readonly bytes:number}>>;

export class ScaleTransportMetrics {
  private readonly values = new Map<ScaleMetricName,{events:number;bytes:number}>();
  record(name:ScaleMetricName, bytes=0, events=1):void {
    if(!SCALE_METRIC_NAMES.includes(name) || !Number.isSafeInteger(bytes) || bytes<0 ||
      !Number.isSafeInteger(events) || events<0) throw new Error('Invalid scale metric');
    const old=this.values.get(name)??{events:0,bytes:0};
    const next={events:old.events+events,bytes:old.bytes+bytes};
    if(!Number.isSafeInteger(next.events)||!Number.isSafeInteger(next.bytes))
      throw new Error('Scale metric overflow');
    this.values.set(name,next);
  }
  snapshot():ScaleMetricSnapshot {
    return Object.fromEntries(SCALE_METRIC_NAMES.map(name=>
      [name,{...(this.values.get(name)??{events:0,bytes:0})}])) as ScaleMetricSnapshot;
  }
}

// Instrumentation must never affect an authenticated request or socket lifecycle.
export function safelyRecordScaleMetric(
  metrics:ScaleTransportMetrics|undefined,name:ScaleMetricName,bytes=0,events=1,
):void {
  try { metrics?.record(name,bytes,events); } catch { /* optional telemetry only */ }
}

// Offline import only: an absent sample is UNKNOWN, never a measured zero.
// This parser does not change the live connection counters or their snapshot API.
export type ScaleMetricObservation = Readonly<{
  classification:'OBSERVED'|'UNKNOWN';events:number|null;bytes:number|null;
}>;
export type ScaleMetricReport = Readonly<Record<ScaleMetricName,ScaleMetricObservation>>;

export function parseScaleTransportMetricRows(rows:unknown):ScaleMetricReport {
  if(!Array.isArray(rows))throw new Error('Scale metric rows must be an array');
  const seen=new Set<string>();
  const observed=new Map<ScaleMetricName,ScaleMetricObservation>();
  for(const value of rows as unknown[]){
    if(!value||typeof value!=='object'||Array.isArray(value))
      throw new Error('Invalid scale metric row');
    const row=value as Record<string,unknown>;
    const name=row.name;
    if(typeof name!=='string'||!(SCALE_METRIC_NAMES as readonly string[]).includes(name))
      throw new Error('Unknown scale metric name');
    if(seen.has(name))throw new Error('Duplicate scale metric name');
    seen.add(name);
    if(row.eventsUnit!=='count'||row.bytesUnit!=='bytes')
      throw new Error('Invalid scale metric units');
    const valid=(n:unknown)=>Number.isSafeInteger(n)&&typeof n==='number'&&n>=0;
    for(const field of ['events','bytes'] as const){
      if(row[field]!==undefined&&row[field]!==null&&!valid(row[field]))
        throw new Error('Invalid scale metric '+field);
    }
    const complete=valid(row.events)&&valid(row.bytes);
    observed.set(name as ScaleMetricName,complete
      ? {classification:'OBSERVED',events:row.events as number,bytes:row.bytes as number}
      : {classification:'UNKNOWN',events:null,bytes:null});
  }
  return Object.fromEntries(SCALE_METRIC_NAMES.map(name=>[name,
    observed.get(name)??{classification:'UNKNOWN',events:null,bytes:null},
  ])) as ScaleMetricReport;
}
