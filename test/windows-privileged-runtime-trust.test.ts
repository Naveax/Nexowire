import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {assertNoPrivilegedNodeStartupFlags,assertWindowsPrivilegedRuntimeTrusted,validatePrivilegedRuntimePaths} from '../src/security/windows-privileged-runtime-trust.js';

const env={
  USERPROFILE:'C:\\Users\\testuser',
  LOCALAPPDATA:'C:\\Users\\testuser\\AppData\\Local',
  APPDATA:'C:\\Users\\testuser\\AppData\\Roaming',
  TEMP:'C:\\Users\\testuser\\AppData\\Local\\Temp',
  ProgramFiles:'C:\\Program Files',
  ProgramData:'C:\\ProgramData',
};

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
