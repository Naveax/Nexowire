import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {cloudflareConnectionLifecycle} from '../src/mcp/cloudflare-connection-lifecycle.js';

// This is a destructive test ONLY of the disposable, randomly named task it
// registers. It never queries or changes NAVEAX / Work-PC system tasks.
// The lab operator sets this flag inside a disposable Windows VM.
const enabled=process.platform==='win32' &&
  process.env.NEXOWIRE_V2_04_DISPOSABLE_WINDOWS_VM==='YES' &&
  process.env.GITHUB_ACTIONS!=='true';

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
type Identity={pid:number;creationDate:string;executablePath:string};
function nativeIdentity(pid:number):Identity|null{
  if(!Number.isSafeInteger(pid)||pid<1)return null;
  const ps=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NonInteractive','-Command',
      '$p=Get-CimInstance Win32_Process -Filter '+JSON.stringify('ProcessId='+pid)+' -ErrorAction Stop;'+
      'if($p){[pscustomobject]@{pid=[int]$p.ProcessId;creationDate=[string]$p.CreationDate;executablePath=[string]$p.ExecutablePath}|ConvertTo-Json -Compress}'],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  if(ps.status!==0||!ps.stdout?.trim())return null;
  try{
    const row=JSON.parse(ps.stdout.trim()) as Identity;
    return row.pid===pid&&row.creationDate&&row.executablePath?row:null;
  }catch{return null;}
}
async function awaitPids(file:string,deadlineMs:number){
  const until=Date.now()+deadlineMs;
  while(Date.now()<until){
    try{
      const p=JSON.parse(await readFile(file,'utf8')) as {parent:number;child:number;grandchild:number};
      if([p.parent,p.child,p.grandchild].every(v=>Number.isSafeInteger(v)&&v>0))return p;
    }catch{}
    await pause(150);
  }
  throw Error('TASK_DID_NOT_LAUNCH_ALL_DISPOSABLE_DESCENDANTS');
}
async function identityGone(original:Identity,timeoutMs=12000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    const now=nativeIdentity(original.pid);
    // PID reuse is not a surviving original process; never kill a reused PID.
    if(!now||now.creationDate!==original.creationDate)return true;
    await pause(180);
  }
  return false;
}

test('V2-04: 20 real disposable Windows Scheduler start/stop cycles and descendant cleanup',{
  skip:!enabled,timeout:15*60*1000,
},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nwx-v2-04-vm-'));
  const taskName='Nexowire Cloudflare VM '+randomUUID();
  const profileFile=path.join(root,'profile.json');
  const tokenFile=path.join(root,'token.txt');
  const scriptFile=path.join(root,'fixture.cjs');
  const pidFile=path.join(root,'pids.json');
  await writeFile(tokenFile,'disposable-token-not-a-real-credential');
  await writeFile(profileFile,JSON.stringify({
    version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),
    binary:path.join(root,'fake-cloudflared.exe'),binarySha256:'a'.repeat(64),
    credentialsFile:path.join(root,'fake-credentials.json'),listenPort:43111,
  }));
  // No TCP connector, agent, broker or real secret is started. Three real
  // Node processes are enough to prove the job's nested process ownership.
  const nested='const {spawn}=require("node:child_process");'+
    'const fs=require("node:fs");'+
    'const grand=spawn(process.execPath,["-e","setInterval(()=>{},500)"],{stdio:"ignore"});'+
    'fs.writeFileSync('+JSON.stringify(pidFile)+',JSON.stringify({parent:Number(process.env.NWX_PARENT),child:process.pid,grandchild:grand.pid}));'+
    'setInterval(()=>{},500);';
  await writeFile(scriptFile,'const {spawn}=require("node:child_process");'+
    'spawn(process.execPath,["-e",'+JSON.stringify(nested)+'],{stdio:"ignore",env:{...process.env,NWX_PARENT:String(process.pid)}});'+
    'setInterval(()=>{},500);');
  const options={root,taskName,executable:process.execPath,cli:scriptFile,
    env:{NEXOWIRE_HTTP_PORT:'43110',NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
      NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
      NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:tokenFile}};
  t.after(async()=>{
    try{await cloudflareConnectionLifecycle('stop',undefined,options)}catch{}
    try{await cloudflareConnectionLifecycle('uninstall',undefined,options)}catch{}
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  });
  const installed=await cloudflareConnectionLifecycle('install',profileFile,options);
  assert.equal(installed.installed,true);
  assert.equal(installed.limited,true);
  assert.equal(installed.autostart,true);
  for(let cycle=1;cycle<=20;cycle++){
    await rm(pidFile,{force:true});
    await cloudflareConnectionLifecycle('start',undefined,options);
    const pids=await awaitPids(pidFile,20000);
    const ids=[pids.parent,pids.child,pids.grandchild].map(nativeIdentity);
    assert.ok(ids.every(x=>x!==null),'native process identity present: '+cycle);
    assert.equal(new Set(ids.map(x=>x!.pid)).size,3);
    assert.ok(ids.every(x=>x!.executablePath.toLowerCase()===process.execPath.toLowerCase()));
    await cloudflareConnectionLifecycle('stop',undefined,options);
    for(const id of ids)assert.equal(await identityGone(id!),true,'survivor on cycle '+cycle+' PID '+id!.pid);
    assert.notEqual((await cloudflareConnectionLifecycle('status',undefined,options)).state,'Running');
  }
});
