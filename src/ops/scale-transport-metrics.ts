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
