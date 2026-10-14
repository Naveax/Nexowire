import path from 'node:path';
import {promises as fs} from 'node:fs';
import {
  collectNativeLaunches,countSignatures,compareLaunchInventory,
} from './ai-screen-launch-paths.js';

const root=process.cwd();
const baselineFile=path.join(root,'scripts','ai-screen-launch-sinks-baseline.json');
const baseline=JSON.parse(await fs.readFile(baselineFile,'utf8')) as{
  version:number;
  capturedFromMain:string;
  limitOfAudit:string;
  observedAtBaseline:Record<string,number>;
};
if(baseline.version!==1||typeof baseline.capturedFromMain!=='string'||
   baseline.limitOfAudit!=='DIRECT_NODE_CHILD_PROCESS_CALLS_ONLY'||
   !baseline.observedAtBaseline||typeof baseline.observedAtBaseline!=='object'){
  throw new Error('AI Screen native launch baseline has an unexpected format.');
}
for(const [key,value] of Object.entries(baseline.observedAtBaseline)){
  if(!/^src\/[A-Za-z0-9_.\/-]+\.(?:ts|tsx)\#(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/.test(key)||
     !Number.isSafeInteger(value)||value<1){
    throw new Error('Invalid AI Screen launch-sink baseline entry: '+key);
  }
}
const scanned=await collectNativeLaunches(root);
const observed=countSignatures(scanned);
const delta=compareLaunchInventory(baseline.observedAtBaseline,observed);
const count=scanned.length;
console.log('[AI Screen launch audit] direct Node child_process callsites: '+count);
console.log('[AI Screen launch audit] tracked signatures: '+
  Object.keys(observed).length);
if(delta.removed.length){
  console.log('[AI Screen launch audit] reduced/removed: '+JSON.stringify(delta.removed));
}
if(delta.unexpected.length){
  console.error('[AI Screen launch audit] NEW OR INCREASED NATIVE LAUNCH SINKS:');
  for(const entry of delta.unexpected){
    const locations=scanned.filter(s=>s.signature===entry.signature)
      .map(s=>s.line).join(',');
    console.error('  '+entry.signature+' baseline='+entry.approved+
      ' current='+entry.found+' lines='+locations);
  }
  console.error('New direct native launch paths need explicit #402 review and a baseline update.');
  process.exitCode=1;
}else{
  console.log('[AI Screen launch audit] no new direct child_process sink counts');
}
console.log('[AI Screen launch audit] WARNING: unchanged launch paths are NOT proved isolated.');
console.log('[AI Screen launch audit] Excludes indirect native/COM/ShellExecute, dynamically'+
  ' generated PowerShell, external scripts and binary descendants.');
