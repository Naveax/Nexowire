import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import './connection-v2-windows-recovery.test.js';
import './connection-v2-windows-hub-rollback.test.js';
import {spawnSync} from 'node:child_process';
import {buildCloudflareConnectionLauncher,cloudflareConnectionLifecycle,windowsConnectionControllerSourceForTest} from '../src/mcp/cloudflare-connection-lifecycle.js';
import {inspectCloudflareConnection} from '../src/mcp/cloudflare-connection-doctor.js';
import {loadConfig} from '../src/config.js';

const environment={NEXOWIRE_HTTP_PORT:'43110',NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
  NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
  NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:path.resolve('protected-service-token')};
// Avoid reading a real service-token file in the isolated read-only doctor.
const config=()=>loadConfig({...environment,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:undefined,
  NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-secret-not-for-transmission'});
const profile=()=>({version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),
  binary:path.resolve('cloudflared'),binarySha256:'a'.repeat(64),credentialsFile:path.resolve('credentials.json'),listenPort:43111});

test('connection launcher preserves quoted Unicode paths and only protected Hub configuration',()=>{
  const source=buildCloudflareConnectionLauncher(path.resolve("Ömer's profile.json"),{
    executable:process.execPath,cli:path.resolve("Ömer's cli.js"),
    env:{...environment,NODE_OPTIONS:'--import evil.js',TUNNEL_URL:'http://evil.test',HTTP_PROXY:'http://proxy.attacker.test',HTTPS_PROXY:'http://proxy.attacker.test',ALL_PROXY:'socks://proxy.attacker.test',NO_PROXY:'localhost.attacker.test',UNRELATED_SECRET:'never-copy'},
  });
  assert.ok(source.startsWith('\uFEFF# Nexowire'));
  assert.ok(source.includes("Ömer''s profile.json"));
  assert.ok(source.includes("Ömer''s cli.js"));
  assert.ok(source.includes("'local-first','cloudflare-run'"));
  assert.ok(source.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'));
  assert.ok(source.includes('CREATE_SUSPENDED'));
  assert.ok(source.includes('AssignProcessToJobObject'));
  assert.equal(source.includes('& '+process.execPath),false);
  assert.equal(source.includes('evil.js'),false);assert.equal(source.includes('never-copy'),false);
  assert.equal(source.includes('proxy.attacker.test'),false);
  assert.equal(source.includes('localhost.attacker.test'),false);
  assert.ok(source.includes('Remove-Item'));
  assert.throws(()=>buildCloudflareConnectionLauncher('relative.json'));
  assert.throws(()=>buildCloudflareConnectionLauncher(path.resolve('profile.json'),{
    env:{NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'must-not-persist'},
  }),/plaintext/);
});

test('public doctor distinguishes OAuth metadata from authenticated tool readiness, without sending secrets',async()=>{
  let calls=0;
  const c=config();
  const status=await inspectCloudflareConnection(profile(),c,async(input,init)=>{
    assert.equal(new Headers(init?.headers).has('authorization'),false);
    assert.equal(JSON.stringify(init).includes('disposable-secret'),false);
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    calls++;
    if(calls===1){assert.equal(String(input),'https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
      return Response.json({resource:c.mcpResourceUrl,authorization_servers:['https://control.example.test/']});}
    assert.equal(init?.method,'POST');return new Response('',{status:401,headers:{
      'www-authenticate':'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    }});
  });
  assert.equal(calls,2);assert.equal(status.publicBoundaryVerified,true);
  assert.equal(status.authenticatedToolVerified,false);
});
test('unbound 401 without exact OAuth challenge cannot pass the public boundary',async()=>{
  let calls=0;
  const status=await inspectCloudflareConnection(profile(),config(),async()=>{
    return ++calls===1?Response.json({resource:'https://mcp.example.test/mcp',
      authorization_servers:['https://control.example.test']}):new Response('',{status:401});
  });
  assert.equal(calls,2);assert.equal(status.publicBoundaryVerified,false);
  assert.equal(status.stage,'PUBLIC_AUTH_BOUNDARY_FAILED');
});

test('wrong public resource or issuer stops diagnostic before MCP POST',async()=>{
  for(const metadata of [
    {resource:'https://wrong.example.test/mcp',authorization_servers:['https://control.example.test']},
    {resource:'https://mcp.example.test/mcp',authorization_servers:['https://attacker.example.test']},
    {resource:'https://mcp.example.test/mcp',authorization_servers:['https://control.example.test','https://attacker.example.test']},
  ]){
    let calls=0;const status=await inspectCloudflareConnection(profile(),config(),async()=>{calls++;return Response.json(metadata);});
    assert.equal(calls,1);assert.equal(status.stage,'PUBLIC_OAUTH_RESOURCE_MISMATCH');
  }
});
test('network failure, excessive metadata and unauthenticated success never report ready',async()=>{
  assert.equal((await inspectCloudflareConnection(profile(),config(),async()=>{throw Error('network');})).publicBoundaryVerified,false);
  assert.equal((await inspectCloudflareConnection(profile(),config(),async()=>new Response('x'.repeat(16385)))).publicBoundaryVerified,false);
  let calls=0;
  assert.equal((await inspectCloudflareConnection(profile(),config(),async()=>++calls===1?
    Response.json({resource:'https://mcp.example.test/mcp',authorization_servers:['https://control.example.test']}):
    new Response('',{status:200}))).stage,'PUBLIC_AUTH_BOUNDARY_FAILED');
});

test('Cloudflare connection task refuses reserved Hub and protected boot task identities',async()=>{
  if(process.platform!=='win32')return;
  for(const name of ['Nexowire Hub','Nexowire Hub Boot','Nexowire Stack']){
    await assert.rejects(cloudflareConnectionLifecycle('status',undefined,{taskName:name}),/Invalid connection task name/);
  }
});

test('Windows connection install refuses a junction root before touching target files',{
  skip:process.platform!=='win32',timeout:30000,
},async t=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'nwx-cf-junction-'));
  t.after(async()=>{await rm(base,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const target=path.join(base,'target'),linked=path.join(base,'linked');
  await mkdir(target);
  await symlink(target,linked,'junction');
  const profileFile=path.join(base,'profile.json');
  const tokenFile=path.join(base,'token.txt');
  await writeFile(profileFile,JSON.stringify(profile()));
  await writeFile(tokenFile,'disposable-fixture-token');
  await assert.rejects(cloudflareConnectionLifecycle('install',profileFile,{
    root:linked,taskName:'Nexowire Cloudflare Link Test '+randomUUID(),
    env:{...environment,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:tokenFile},
    executable:process.execPath,cli:path.resolve('dist/src/cli.js'),
  }),/CONNECTION_ROOT_REPARSE/);
  await assert.rejects(readFile(path.join(target,'launch.ps1'),'utf8'),{code:'ENOENT'});
});

test('Windows controller PowerShell 5.1 source parses without executing any task',{
  skip:process.platform!=='win32',timeout:30000,
},()=>{
  const parse=String.raw`$source=[Console]::In.ReadToEnd()
$tokens=$null
$parseErrors=$null
[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors) | Out-Null
foreach($parseErr in $parseErrors){
  # Only bounded parser diagnostic IDs/line/column, never source or secrets.
  $id=[string]$parseErr.ErrorId
  if($id -notmatch '^[a-zA-Z0-9_-]{1,100}$'){$id='UNRECOGNIZED'}
  [Console]::Out.WriteLine($id+'@'+$parseErr.Extent.StartLineNumber+':'+$parseErr.Extent.StartColumnNumber)
}
if($parseErrors.Count -gt 0){exit 3}
exit 0`;
  const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-Command',parse],{
      input:windowsConnectionControllerSourceForTest(),encoding:'utf8',timeout:15000,windowsHide:true,
    });
  assert.equal(result.status,0,'PowerShell parser failures: '+(result.stdout??'').slice(0,1000));
});

test('hosted disposable Windows task refuses foreign action without rewriting its principal', {
  skip:!(process.platform==='win32' && process.env.GITHUB_ACTIONS==='true' &&
    process.env.RUNNER_OS==='Windows' && process.env.RUNNER_ENVIRONMENT==='github-hosted'),
  timeout:75000,
},async t=>{
  const taskName='Nexowire Cloudflare Foreign '+randomUUID();
  const invoke=(script:string)=>spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
      windowsHide:true,encoding:'utf8',timeout:20000,
      env:{...process.env,NEXOWIRE_TEST_FOREIGN_TASK:taskName},
    });
  const install=invoke(String.raw`$ErrorActionPreference='Stop'
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
$u=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$a=New-ScheduledTaskAction -Execute 'C:\Windows\System32\cmd.exe' -Argument '/c exit 0'
$p=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited
$t=New-ScheduledTaskTrigger -AtLogOn -User $u
Register-ScheduledTask -TaskName $env:NEXOWIRE_TEST_FOREIGN_TASK -TaskPath '\' -Action $a -Principal $p -Trigger $t -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew) | Out-Null`);
  assert.equal(install.status,0,'disposable foreign-task fixture registration');
  t.after(()=>{
    const cleaned=invoke(String.raw`Unregister-ScheduledTask -TaskName $env:NEXOWIRE_TEST_FOREIGN_TASK -TaskPath '\' -Confirm:$false -ErrorAction Stop`);
    assert.equal(cleaned.status,0,'disposable fixture cleanup must succeed');
  });
  const exportTask=()=>invoke(String.raw`Export-ScheduledTask -TaskName $env:NEXOWIRE_TEST_FOREIGN_TASK -TaskPath '\' -ErrorAction Stop`);
  const before=exportTask();
  assert.equal(before.status,0);
  await assert.rejects(cloudflareConnectionLifecycle('status',undefined,{taskName}),/CONNECTION_TASK_NOT_OWNED/);
  await assert.rejects(cloudflareConnectionLifecycle('uninstall',undefined,{taskName}),/CONNECTION_TASK_NOT_OWNED/);
  const after=exportTask();
  assert.equal(after.status,0);
  assert.equal(after.stdout,before.stdout,'foreign task action/principal must be unchanged');
});

test('Windows user-logon task registers limited and cannot be silently overwritten',{
  skip:process.platform!=='win32',timeout:120000,
},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-cf-task-'));
  const file=path.join(root,'profile.json');await writeFile(file,JSON.stringify(profile()));
  const tokenFile=path.join(root,'protected-token.txt');await writeFile(tokenFile,'disposable-service-token-12345');
  const options={root,taskName:'Nexowire Cloudflare Test '+randomUUID(),
    env:{...environment,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:tokenFile},
    executable:process.execPath,cli:path.resolve('dist/src/cli.js')};
  t.after(async()=>{
    await cloudflareConnectionLifecycle('uninstall',undefined,options);
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const installed=await cloudflareConnectionLifecycle('install',file,options);
  assert.equal(installed.installed,true);assert.equal(installed.limited,true);assert.equal(installed.autostart,true);
  assert.notEqual(installed.state,'Running','registration does not interrupt or auto-start any existing process');
  const before=await readFile(path.join(root,'launch.ps1'),'utf8');
  const beforeHash=await readFile(path.join(root,'launch.ps1.sha256'),'utf8');
  assert.match(beforeHash,/^[A-F0-9]{64}\n$/);
  await assert.rejects(cloudflareConnectionLifecycle('install',file,options),/already installed/);
  assert.equal(await readFile(path.join(root,'launch.ps1'),'utf8'),before);
  // An attacker can preserve the BOM and banner; the pinned digest must still deny.
  await writeFile(path.join(root,'launch.ps1'),before+'# unauthorized change\r\n');
  await assert.rejects(cloudflareConnectionLifecycle('start',undefined,options),/refused/);
  await writeFile(path.join(root,'launch.ps1'),before);
  assert.equal(await readFile(path.join(root,'launch.ps1.sha256'),'utf8'),beforeHash);
  await cloudflareConnectionLifecycle('uninstall',undefined,options);
  assert.equal((await cloudflareConnectionLifecycle('status',undefined,options)).installed,false);
  await assert.rejects(readFile(path.join(root,'launch.ps1.sha256'),'utf8'),{code:'ENOENT'});
  // A clean uninstall permits a fresh explicit registration.
  assert.equal((await cloudflareConnectionLifecycle('install',file,options)).installed,true);
});

test('Windows connection task stop terminates its real disposable process tree',{
  skip:process.platform!=='win32',timeout:120000,
},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-cf-tree-'));
  const profileFile=path.join(root,'profile.json');await writeFile(profileFile,JSON.stringify(profile()));
  const tokenFile=path.join(root,'token.txt');await writeFile(tokenFile,'disposable-service-token-12345');
  const pidFile=path.join(root,'pids.json'),cli=path.join(root,'disposable.cjs');
  await writeFile(cli,`const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const options={root,taskName:'Nexowire Cloudflare Tree Test '+randomUUID(),executable:process.execPath,cli,
    env:{...environment,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:tokenFile}};
  let pids:{parent:number;child:number}|undefined;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  t.after(async()=>{
    await cloudflareConnectionLifecycle('stop',undefined,options);
    // No bare-PID kill: a PID may have been recycled into a foreign process.
    // Stop-ScheduledTask and the owned Job Object are the only cleanup path.
    await cloudflareConnectionLifecycle('uninstall',undefined,options);
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  await cloudflareConnectionLifecycle('install',profileFile,options);
  await cloudflareConnectionLifecycle('start',undefined,options);
  const deadline=Date.now()+20000;
  while(!pids&&Date.now()<deadline){try{pids=JSON.parse(await readFile(pidFile,'utf8'));}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.ok(pids,'limited user-logon task must actually execute the disposable fixture');
  assert.equal(alive(pids.parent),true);assert.equal(alive(pids.child),true);
  await cloudflareConnectionLifecycle('stop',undefined,options);
  const stopDeadline=Date.now()+10000;
  while((alive(pids.parent)||alive(pids.child))&&Date.now()<stopDeadline)await new Promise(r=>setTimeout(r,100));
  assert.equal(alive(pids.parent),false,'task stop must stop the managed parent');
  assert.equal(alive(pids.child),false,'task stop must leave no orphan connector descendant');
});

test('V2-04: existing SYSTEM Hub Boot is a separate user-Hub start blocker',async()=>{
  const {hubHandoffBlockers,assessHubBootRepairPreflight}=await import('../src/hub/hub-lifecycle.js');
  const args={legacyStackTaskState:null,standaloneHubTaskState:null,listenerPid:null};
  assert.deepEqual(hubHandoffBlockers({...args,bootTaskState:'Ready',bootTaskPrincipalSid:'S-1-5-18'}),['SYSTEM_HUB_BOOT_ENABLED']);
  assert.deepEqual(hubHandoffBlockers({...args,bootTaskState:'Disabled',bootTaskPrincipalSid:'S-1-5-18'}),[]);
  assert.deepEqual(hubHandoffBlockers({...args,bootTaskState:'Disabled',bootTaskPrincipalSid:'S-1-5-21-foreign'}),['HUB_BOOT_PRINCIPAL_UNVERIFIED']);
  const sha='A'.repeat(64);
  const evidence={target:'disposable-windows-vm' as const,bootPrincipalSid:'S-1-5-18',
    originalTaskXmlHash:sha,sealedBackupTaskXmlHash:sha.toLowerCase(),
    originalTaskActionPrincipalTriggersVerified:true,originalLauncherBackupVerified:true,
    rollbackCredentialsVerified:true,replacementPublisherVerified:true,
    replacementSignedDigestVerified:true,agentBrokerCompatibilityVerified:true,
    userHubDisabled:true,noUnownedHubListener:true};
  assert.deepEqual(assessHubBootRepairPreflight(evidence),{eligibleForManualLabReview:true,blockers:[],mutationAuthorized:false});
  const blocked=assessHubBootRepairPreflight({...evidence,target:'production-host',rollbackCredentialsVerified:false,replacementPublisherVerified:false});
  assert.equal(blocked.eligibleForManualLabReview,false);
  assert.equal(blocked.mutationAuthorized,false);
  assert.deepEqual(blocked.blockers,['HUB_BOOT_NON_DISPOSABLE_TARGET','HUB_BOOT_CREDENTIAL_ROLLBACK_UNKNOWN','HUB_BOOT_REPLACEMENT_UNTRUSTED']);
});
test('V2-04: connection restart interval, count and working directory are pinned',()=>{
  const source=windowsConnectionControllerSourceForTest();
  assert.ok(source.includes('RestartCount -ne 3'));
  assert.ok(source.includes('XmlConvert]::ToTimeSpan'));
  assert.ok(source.includes("WorkingDirectory -ne ''"));
});
