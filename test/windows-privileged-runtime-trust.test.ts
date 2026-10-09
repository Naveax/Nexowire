import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertNoPrivilegedNodeStartupFlags,assertWindowsPrivilegedRuntimeTrusted,validatePrivilegedRuntimePaths,buildPrivilegedPowerShellAuditEnv,privilegedRuntimeAuditSucceeded} from '../src/security/windows-privileged-runtime-trust.js';

const env={
  USERPROFILE:'C:\\Users\\testuser',
  LOCALAPPDATA:'C:\\Users\\testuser\\AppData\\Local',
  APPDATA:'C:\\Users\\testuser\\AppData\\Roaming',
  TEMP:'C:\\Users\\testuser\\AppData\\Local\\Temp',
  ProgramFiles:'C:\\Program Files',
  ProgramData:'C:\\ProgramData',
};

test('highest audit uses only pinned Windows environment, not caller module/preload paths',()=>{
  const out=buildPrivilegedPowerShellAuditEnv({
    executable:'C:\\Program Files\\Nexowire\\node.exe',
    cliEntrypoint:'C:\\ProgramData\\Nexowire\\runtime\\cli.js',
    codeRoot:'C:\\ProgramData\\Nexowire\\runtime',
  });
  assert.deepEqual(Object.keys(out).sort(),[
    'SystemRoot','windir','ComSpec','PATH','PSModulePath',
    'NEXOWIRE_TRUST_EXE','NEXOWIRE_TRUST_CLI','NEXOWIRE_TRUST_ROOT',
  ].sort());
  assert.equal(out.PSModulePath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(out.PATH,'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  for(const key of [
    'APPDATA','LOCALAPPDATA','USERPROFILE','TEMP','TMP',
    'NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS',
    'PSExecutionPolicyPreference','PSModuleAnalysisCachePath',
    'POWERSHELL_UPDATECHECK','HOME',
  ])assert.equal(out[key],undefined,key);
  assert.equal(out.NEXOWIRE_TRUST_CLI,'C:\\ProgramData\\Nexowire\\runtime\\cli.js');
});

test('Windows inbox PowerShell Security module works with isolated audit environment',{
  skip:process.platform!=='win32',
},()=>{
  const sys='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(existsSync(sys),true);
  const env=buildPrivilegedPowerShellAuditEnv({
    executable:'C:\\Windows\\System32\\cmd.exe',
    cliEntrypoint:'C:\\Windows\\System32\\cmd.exe',
    codeRoot:'C:\\Windows\\System32',
  });
  const source=[
    "$ErrorActionPreference='Stop'",
    "$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'",
    "Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop",
    "if(-not (Get-Acl -LiteralPath 'C:\\Windows\\System32\\cmd.exe' -ErrorAction Stop)){exit 4}",
    "Write-Output 'INBOX_SECURITY_MODULE_OK'",
  ].join(';');
  const result=spawnSync(sys,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{
    encoding:'utf8',shell:false,env,cwd:'C:\\Windows\\System32',
    timeout:20000,windowsHide:true,
  });
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
  assert.match(result.stdout,/INBOX_SECURITY_MODULE_OK/);
});

test('highest privilege runtime gate never trusts user AppData or arbitrary staging roots',()=>{
  const targets=[
    ['C:\\Users\\testuser\\AppData\\Local\\Nexowire\\runtime\\node.exe',
      'C:\\Users\\testuser\\AppData\\Local\\Nexowire\\app\\dist\\src\\cli.js'],
    ['C:\\Windows\\Temp\\nx\\node.exe','C:\\Windows\\Temp\\nx\\cli.js'],
    ['C:\\ProgramData\\Nexowire\\node.exe',
      'C:\\Users\\testuser\\Downloads\\nx\\cli.js'],
    ['.\\node.exe','.\\cli.js'],
  ];
  for(const [executable,cliEntrypoint] of targets){
    assert.throws(()=>validatePrivilegedRuntimePaths({executable:executable!,cliEntrypoint:cliEntrypoint!,env}),
      /PRIVILEGED_RUNTIME_/);
  }
});

test('protected Hub cannot inherit Node preload/import/loader flags',()=>{
  assert.doesNotThrow(()=>assertNoPrivilegedNodeStartupFlags([]));
  for(const flags of [['--require','C:\\Users\\testuser\\hook.js'],['--import','file:///C:/Temp/hook.js'],['--inspect'],['--loader','unsafe.mjs']]){
    assert.throws(()=>assertNoPrivilegedNodeStartupFlags(flags),/PRIVILEGED_RUNTIME_NODE_FLAGS/);
  }
});

test('untrusted runtime path rejects before attempting Windows elevation checks',()=>{
  if(process.platform!=='win32')return;
  assert.throws(()=>assertWindowsPrivilegedRuntimeTrusted({
    executable:process.execPath,cliEntrypoint:fileURLToPath(import.meta.url),env,
  }),/PRIVILEGED_RUNTIME_/);
});

test('boot-install applies read-only runtime guard before touching DPAPI or launcher',()=>{
  const file=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const fn=file.indexOf('export async function installHubBootLifecycle(');
  const guard=file.indexOf('assertWindowsPrivilegedRuntimeTrusted({',fn);
  const sourceFile=file.indexOf('currentUserHubLauncher(options)',fn);
  const secret=file.indexOf('readProtectedSecretFile(',fn);
  const write=file.indexOf('writeProtectedSecretFile(',fn);
  assert.ok(fn>=0 && guard>fn && sourceFile>guard && secret>sourceFile && write>secret);
  assert.match(file,/await assertNoLegacyStackSupervisor/);
});

test('runtime trust gate rejects partial/fake markers and unsuccessful commands',()=>{
  assert.equal(privilegedRuntimeAuditSucceeded({
    status:0,stdout:'TRUSTED_RUNTIME_CODE_TREE\r\n',
  }),true);
  for(const outcome of [
    {status:0,stdout:'prefix TRUSTED_RUNTIME_CODE_TREE'},
    {status:0,stdout:'TRUSTED_RUNTIME_CODE_TREE\nUNSAFE'},
    {status:0,stdout:'TRUSTED_RUNTIME_CODE_TREE_EXTRA'},
    {status:0,stdout:''},
    {status:1,stdout:'TRUSTED_RUNTIME_CODE_TREE'},
    {status:null,stdout:'TRUSTED_RUNTIME_CODE_TREE'},
    {status:0,stdout:'TRUSTED_RUNTIME_CODE_TREE',error:new Error('spoof')},
  ]){
    assert.equal(privilegedRuntimeAuditSucceeded(outcome),false);
  }
});

test('runtime trust gate pins native Node host to Valid OpenJS Foundation publisher',()=>{
  const src=readFileSync(new URL('../src/security/windows-privileged-runtime-trust.ts',import.meta.url),'utf8');
  assert.match(src,/Get-AuthenticodeSignature -LiteralPath \$exe\.FullName -ErrorAction Stop/);
  assert.match(src,/RUNTIME_NODE_EXE_UNSAFE_TYPE/);
  assert.match(src,/RUNTIME_NODE_SIGNER_UNTRUSTED/);
  assert.match(src,/CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US/);
  assert.match(src,/\$signature\.Status -ne 'Valid'/);
  assert.ok(src.indexOf("Get-AuthenticodeSignature")<src.indexOf("Write-Output 'TRUSTED_RUNTIME_CODE_TREE'"));
  assert.ok(src.includes('if(!privilegedRuntimeAuditSucceeded(result))'));
});

test('installed official Windows Node.js host has a validated OpenJS publisher',{
  skip:process.platform!=='win32'||!existsSync('C:\\Program Files\\nodejs\\node.exe'),
},()=>{
  const sys='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const source=[
    "$ErrorActionPreference='Stop'",
    "$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'",
    "Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop",
    "$s=Get-AuthenticodeSignature -LiteralPath 'C:\\Program Files\\nodejs\\node.exe' -ErrorAction Stop",
    "if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -cne 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'){throw 'INVALID_NODE_PUBLISHER'}",
    "Write-Output 'NODE_HOST_SIGNER_OK'",
  ].join(';');
  const res=spawnSync(sys,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{
    encoding:'utf8',shell:false,windowsHide:true,timeout:20000,
    cwd:'C:\\Windows\\System32',
    env:buildPrivilegedPowerShellAuditEnv({
      executable:'C:\\Program Files\\nodejs\\node.exe',
      cliEntrypoint:'C:\\ProgramData\\Nexowire\\runtime\\cli.js',
      codeRoot:'C:\\ProgramData\\Nexowire\\runtime',
    }),
  });
  assert.equal(res.status,0,res.stderr+' '+res.stdout);
  assert.equal(res.stdout.trim(),'NODE_HOST_SIGNER_OK');
});

test('trust inspector never writes DACLs, spawns agents or publishes protected values',()=>{
  const file=readFileSync(new URL('../src/security/windows-privileged-runtime-trust.ts',import.meta.url),'utf8');
  assert.match(file,/TRUSTED_RUNTIME_CODE_TREE/);
  assert.match(file,/Get-Acl/);
  assert.match(file,/Get-ChildItem/);
  assert.match(file,/RUNTIME_UNTRUSTED_WRITE_ACE/);
  for(const unsafe of ['icacls.exe','Set-Acl','takeown.exe','Stop-Process','Set-Content','Start-ScheduledTask',
    'Register-ScheduledTask','Start-Process','WriteAllText','Copy-Item','Remove-Item']){
    assert.equal(file.includes(unsafe),false,unsafe);
  }
});
