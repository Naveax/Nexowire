import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// #04 owner source-level UI acceptance against real production web/app.js.
// The #23 independent QA suite is NOT modified or copied into this branch.
const app=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');
const tierStart=app.indexOf('function getDeviceTier(device) {');
const tierEnd=app.indexOf('\nfunction syncDeviceToolbar(',tierStart);
const coreStart=app.indexOf('const core = device.persistentMaintenance ??');
const coreEndMarker='corePanel.hidden = true;';
const coreEnd=app.indexOf(coreEndMarker,coreStart);
assert.ok(tierStart>=0&&tierEnd>tierStart&&coreStart>=0&&coreEnd>coreStart);
const getTier=new Function('return ('+app.slice(tierStart,tierEnd).trim()+');')() as
  (device:unknown)=>string;
type Rendered={effective:boolean;label:string;pressed:string|undefined;active:boolean};
const renderCore=new Function('device','row',
  app.slice(coreStart,coreEnd+coreEndMarker.length)+
  '\nreturn {effective:coreEffective,label:coreShortcut.textContent,'+
  'pressed:coreShortcut.getAttribute("aria-pressed"),'+
  'active:coreShortcut.classList.contains("active")};') as
  (device:unknown,row:unknown)=>Rendered;
const row=()=>{
  const map=new Map<string,unknown>();
  for(const key of ['.core-confirm-panel','.core-toggle','.core-copy',
    '.core-shortcut','.core-access']){
    const flags=new Set<string>(),attrs=new Map<string,string>();
    map.set(key,{
      textContent:'',hidden:false,
      classList:{
        toggle(name:string,active:boolean){if(active)flags.add(name);else flags.delete(name)},
        contains(name:string){return flags.has(name)},
      },
      setAttribute(name:string,value:string){attrs.set(name,value)},
      getAttribute(name:string){return attrs.get(name)},
    });
  }
  return {querySelector:(key:string)=>map.get(key)};
};
const snapshot=()=>({
  platform:'win32',accessMode:'full',online:true,
  currentOwnerEpoch:5,currentGrantGeneration:9,
  persistentMaintenance:{
    enabled:true,active:true,effective:true,
    authoritySource:'independent-protected-windows-broker',
    localEnrollmentVerified:true,actualElevatedTokenVerified:true,
    brokerSourceAclVerified:true,brokerVersionVerified:true,
    ownerEpoch:4,grantGeneration:8,
    finalNativeEffectVerified:false,externalCasAtomicCommitVerified:false,
  },
});
function mustPause(input:unknown){
  const view=renderCore(input,row());
  assert.equal(view.effective,false);
  assert.equal(view.pressed,'false');
  assert.equal(view.active,false);
  assert.equal(view.label,'CORE KAYITLI • YETKİ BEKLEMEDE');
  assert.equal(getTier(input),'full');
}
test('#04 real UI: 1ms-old owner epoch all-green client snapshot is NOT native HIGH CORE EFFECTIVE',()=>{
  mustPause(snapshot());
});
test('#04 real UI: even a matching epoch without physically witnessed final native/CAS stays paused',()=>{
  const device=snapshot();
  device.persistentMaintenance.ownerEpoch=5;
  device.persistentMaintenance.grantGeneration=9;
  mustPause(device);
});
test('#04 real UI: prior ACTIVE preference does not pollute persistent tier when EFFECTIVE is false',()=>{
  const device=snapshot();
  device.persistentMaintenance.effective=false;
  device.persistentMaintenance.active=true;
  mustPause(device);
});
test('#04 real UI: stale signed generation and wrong type booleans/epochs remain fail closed',()=>{
  const device=snapshot();
  const core=device.persistentMaintenance;
  core.finalNativeEffectVerified=true;
  core.externalCasAtomicCommitVerified=true;
  core.ownerEpoch=5;
  core.grantGeneration=8;
  mustPause(device);
  for(const change of [
    {ownerEpoch:'5'}, {grantGeneration:'9'},
    {finalNativeEffectVerified:'true'}, {externalCasAtomicCommitVerified:1},
  ]){
    const hostile={
      ...snapshot(),persistentMaintenance:{...core,grantGeneration:9,...change},
    };
    mustPause(hostile);
  }
});
test('#04 UI: no native final CAS proof fields in actual server contract => no premature EFFECTIVE',()=>{
  const device=snapshot();
  device.persistentMaintenance.ownerEpoch=5;
  device.persistentMaintenance.grantGeneration=9;
  const noProof={...device,persistentMaintenance:{
    enabled:true,active:true,effective:true,
    authoritySource:'independent-protected-windows-broker',
    localEnrollmentVerified:true,actualElevatedTokenVerified:true,
    brokerSourceAclVerified:true,brokerVersionVerified:true,
    ownerEpoch:5,grantGeneration:9,
  }};
  mustPause(noProof);
});
