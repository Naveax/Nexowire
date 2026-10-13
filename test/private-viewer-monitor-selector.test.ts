import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ZodError} from 'zod';
import {parseLocalMonitorSelection} from '../src/agent/windows-private-viewer.js';

test('locally selected display stays within private capture, default all monitors',()=>{
  assert.deepEqual(parseLocalMonitorSelection({source:'desktop'}),{selectedMonitorId:null,selectedWindowHwnd:null});
  assert.deepEqual(
    parseLocalMonitorSelection({source:'monitor',monitor_id:'\\\\.\\DISPLAY1'}),
    {selectedMonitorId:'\\\\.\\DISPLAY1',selectedWindowHwnd:null},
  );
});

test('local monitor selector rejects missing or conflicting monitor scope',()=>{
  for(const invalid of [
    {source:'monitor'},
    {source:'desktop',monitor_id:'ANY'},
    {source:'physical_desktop'},
    {source:'monitor',monitor_id:''},
    {source:'monitor',monitor_id:42},
    {source:'desktop',some_other_command:true},
  ])assert.throws(()=>parseLocalMonitorSelection(invalid),ZodError,JSON.stringify(invalid));
});

test('viewer emits native monitor inventory, one monitor option and explicit all-monitors control',async()=>{
  const s=await fs.readFile(new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8');
  for(const required of [
    "source: state.selectedWindowHwnd ? 'window' : (state.selectedMonitorId ? 'monitor' : 'desktop')",
    "monitor_id:state.selectedMonitorId",
    "selectedMonitorId: null",
    "source='desktop'",
    "source='monitor'",
    "source='window'",
    "PREVIEW WINDOW",
    "ALL SCREENS",
    "ALL MONITORS",
    'MonitorSelectionPath',
    'DisplaysPath',
    'Update-MonitorPicker',
    'writeMonitorInventory',
    'selectedMonitorId: state.selectedMonitorId',
  ])assert.ok(s.includes(required),required);
});

test('embedded Windows PowerShell WPF viewer has valid syntax without displaying UI',{
  skip:process.platform!=='win32',
},async()=>{
  const s=await fs.readFile(new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8');
  const key='const viewerScript = String.raw`';
  const a=s.indexOf(key),b=s.indexOf('`;\n\nasync function ensureViewerScript()',a);
  assert.ok(a>0&&b>a);
  const script=s.slice(a+key.length,b);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-viewer-monitor-'));
  try{
    const file=path.join(root,'viewer.ps1');
    await fs.writeFile(file,script,'utf8');
    const cmd=`$tok=$null;$err=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'","''")}',[ref]$tok,[ref]$err);if($err.Count){$err|ForEach-Object{Write-Error $_.Message};exit 1}`;
    const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',cmd],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr||result.stdout);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
