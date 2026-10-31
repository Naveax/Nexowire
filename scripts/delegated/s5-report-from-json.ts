/** Offline recorded-sample formatter; never runs benchmarks or certifies capacity. */
import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export interface Measurement {schema:'delegated-s5-samples-v1'; kind:'local'|'synthetic'; startedAtUtc:string; endedAtUtc:string; environment:string; unit:'ms'; samples:{ok:boolean; latency:number|null}[]}
const UNKNOWN='UNKNOWN';
export function summarize(input:Measurement){
  if(!input||input.schema!=='delegated-s5-samples-v1'||!['local','synthetic'].includes(input.kind)||input.unit!=='ms'||typeof input.environment!=='string'||!input.environment.trim())throw Error('Invalid schema/environment/unit');
  for(const t of [input.startedAtUtc,input.endedAtUtc]){
    if(typeof t!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(t)||!Number.isFinite(Date.parse(t))||new Date(t).toISOString()!==t.replace(/Z$/,t.includes('.')?'Z':'.000Z'))throw Error('Canonical UTC timestamps required');
  }
  if(Date.parse(input.endedAtUtc)<Date.parse(input.startedAtUtc))throw Error('Reversed window');
  if(!Array.isArray(input.samples)||input.samples.length>100000)throw Error('Invalid sample count');
  for(const s of input.samples)if(!s||Object.keys(s).some(k=>!['ok','latency'].includes(k))||typeof s.ok!=='boolean'||(s.latency!==null&&(typeof s.latency!=='number'||!Number.isFinite(s.latency)||s.latency<0)))throw Error('Invalid sample');
  const values=input.samples.flatMap(s=>s.latency===null?[]:[s.latency]).sort((a,b)=>a-b);
  const percentile=(p:number)=>values.length?values[Math.ceil(values.length*p)-1]!:UNKNOWN;
  return {kind:input.kind,environment:input.environment,startedAtUtc:input.startedAtUtc,endedAtUtc:input.endedAtUtc,unit:input.unit,samples:input.samples.length,latencySamples:values.length,success:input.samples.filter(s=>s.ok).length,errors:input.samples.filter(s=>!s.ok).length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),capacity:UNKNOWN,warning:values.length<100?'INSUFFICIENT_SAMPLES: fewer than 100 latency observations; tail estimates unstable':'No confidence interval; recorded samples only'};
}
function cell(v:unknown){return String(v).replace(/[\r\n|]/g,' ')}
export function markdown(input:Measurement){const r=summarize(input);return '# Recorded S5 samples — NOT capacity acceptance\n\nNearest-rank percentiles across all observed outcomes. Null latency excluded.\n\n| Field | Value |\n|---|---|\n'+Object.entries(r).map(([k,v])=>'| '+k+' | '+cell(v)+' |').join('\n')+'\n'}
export function csv(input:Measurement){const r=summarize(input);const quote=(v:unknown)=>{const raw=String(v);const safe=typeof v==='string'&&/^[\s\u0000-\u0020]*[=+@-]/.test(raw)?"'"+raw:raw;return '"'+safe.replaceAll('"','""')+'"'};return Object.keys(r).map(quote).join(',')+'\n'+Object.values(r).map(quote).join(',')+'\n'}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const [file,format='md',...extra]=process.argv.slice(2);if(!file||extra.length||!['md','csv'].includes(format)||!statSync(file).isFile()||statSync(file).size>10_000_000)throw Error('Usage: node scripts/delegated/s5-report-from-json.ts LOCAL.json [md|csv] (max 10MB)');const input=JSON.parse(readFileSync(file,'utf8')) as Measurement;process.stdout.write(format==='csv'?csv(input):markdown(input))}catch(e){process.stderr.write(String(e)+'\n');process.exitCode=2}}
