import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {
  projectS5Matrix,quoteS5Cost,formatS5CostCsv,
  type S5CostInput,type S5RateQuotes,
} from '../src/ops/scale-s5-cost-envelope.js';

type OfflineScenario={label:string;assumptions?:Partial<S5CostInput>|null;rates?:S5RateQuotes};
export function renderS5CostReport(args:string[]):string{
  const csv=args.includes('--csv');
  const flags=args.filter(arg=>arg!=='--csv');
  if(flags.length!==0&&!(flags.length===2&&flags[0]==='--input')){
    throw new Error('Usage: report-s5-cost-matrix.ts [--csv] [--input local.json]');
  }
  let scenarios:OfflineScenario[];
  const embedded=flags.length===0?projectS5Matrix():null;
  if(flags.length){
    const buffer=readFileSync(flags[1]!);
    if(buffer.byteLength>1024*1024)throw new Error('Offline scenario exceeds 1 MiB');
    const input:unknown=JSON.parse(buffer.toString('utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input)){
      throw new Error('Offline scenario must be a JSON object');
    }
    const record=input as Record<string,unknown>;
    if(Object.keys(record).some(k=>!['label','assumptions','rates'].includes(k))||
      (record.label!==undefined&&typeof record.label!=='string')){
      throw new Error('Unexpected offline scenario field');
    }
    scenarios=[{label:record.label as string|undefined??'local offline scenario',
      assumptions:record.assumptions as Partial<S5CostInput>|null|undefined,
      rates:record.rates as S5RateQuotes|undefined}];
  }else{
    scenarios=embedded!.map(s=>({label:s.label,assumptions:s.assumptions}));
  }
  const rows=scenarios.map(s=>({
    label:s.label,activeUsers:s.assumptions?.activeUsers??'UNKNOWN' as const,
    report:quoteS5Cost(s.assumptions,s.rates),
  }));
  if(csv)return formatS5CostCsv(rows);
  return JSON.stringify({
    generatedAt:new Date().toISOString(),
    source:'OFFLINE SIMULATION; not a provider invoice, measured usage, or complete bill',
    actualProviderBill:'UNKNOWN',
    pricesAsOf:embedded?'2026-10-18':'UNKNOWN',
    embeddedRateAssumptionsAsOf:embedded?'2026-10-18':'UNKNOWN',
    scenarios:rows.map((row,i)=>embedded?{
      ...embedded[i],...row,
      embeddedRateWarning:'Historical hypothetical partial estimate, not a current provider quote',
    }:row),
  },null,2)+'\n';
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    process.stdout.write(renderS5CostReport(process.argv.slice(2)));
  }catch(error){
    process.stderr.write('S5 cost report: '+(error instanceof Error?error.message:String(error))+'\n');
    process.exitCode=2;
  }
}
