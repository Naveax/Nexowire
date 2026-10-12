import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertProtectedHubBootRoot,assertCanonicalHubBootTaskNames} from '../src/hub/hub-boot-lifecycle.js';

test('SYSTEM Hub Boot allows exactly one canonical protected directory',()=>{
  assert.doesNotThrow(()=>assertProtectedHubBootRoot('C:\\ProgramData\\Nexowire\\hub-boot'));
  assert.doesNotThrow(()=>assertProtectedHubBootRoot('c:\\programdata\\nexowire\\hub-boot\\'));
  for(const bad of [
    'C:\\ProgramData\\Nexowire\\other','C:\\ProgramData\\NexowireStack',
    'C:\\Users\\test\\Nexowire\\hub-boot',
    'C:\\Windows\\Temp\\Nexowire\\hub-boot',
    'D:\\ProgramData\\Nexowire\\hub-boot',
    '\\\\server\\share\\Nexowire\\hub-boot',
    '\\\\?\\C:\\ProgramData\\Nexowire\\hub-boot',
    '.\\Nexowire\\hub-boot',
    'C:\\ProgramData\\Nexowire\\hub-boot\\subdir',
    'C:\\ProgramData\\Nexowire\\hub-boot\\..\\elsewhere',
    '', 'C:',
  ])assert.throws(()=>assertProtectedHubBootRoot(bad),/HUB_BOOT_UNTRUSTED_PROTECTED_ROOT/,bad);
});

test('elevated Hub Boot task operations reject caller-selected boot and user task names',()=>{
  assert.doesNotThrow(()=>assertCanonicalHubBootTaskNames({}));
  for(const options of [
    {bootTaskName:'Foreign Boot'},
    {windowsTaskName:'Foreign Hub'},
    {env:{NEXOWIRE_HUB_BOOT_TASK_NAME:'Different Boot'}},
    {env:{NEXOWIRE_HUB_TASK_NAME:'Different Hub'}},
  ]){
    assert.throws(()=>assertCanonicalHubBootTaskNames(options),
      /HUB_BOOT_NONCANONICAL_TASK_DENIED/);
  }
});

test('Hub Boot install checks task identity before reading DPAPI and rechecks before registration',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const begin=src.indexOf('export async function installHubBootLifecycle(');
  const end=src.indexOf('export async function uninstallHubBootLifecycle(',begin);
  const install=src.slice(begin,end);
  const names=install.indexOf('assertCanonicalHubBootTaskNames(options)');
  const firstTask=install.indexOf('Get-ScheduledTask -TaskName $boot');
  const firstGuard=install.indexOf('hubBootRegisteredTaskIdentityGuard');
  const preflight=install.indexOf('await runPowerShellJson<{ok:true}>');
  const secret=install.indexOf('readProtectedSecretFile(');
  const register=install.indexOf('Register-ScheduledTask -TaskName $boot');
  const secondGuard=install.indexOf('hubBootRegisteredTaskIdentityGuard',firstGuard+1);
  assert.ok(names>=0 && names<firstTask && firstTask<firstGuard);
  assert.ok(firstGuard<secret && preflight<secret);
  assert.ok(secret<secondGuard && secondGuard<register);
  assert.ok(install.indexOf('hubBootRegisteredTaskIdentityGuard',secondGuard+1)>register,
    'rollback also checks task identity before removing it');
});

test('Hub Boot uninstall refuses foreign tasks before stop, unregister or restoring user Hub',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const begin=src.indexOf('export async function uninstallHubBootLifecycle(');
  const end=src.indexOf('export async function runHubBootLifecycleCommand(',begin);
  const uninstall=src.slice(begin,end);
  const names=uninstall.indexOf('assertCanonicalHubBootTaskNames(options)');
  const guard=uninstall.indexOf('hubBootRegisteredTaskIdentityGuard');
  const stop=uninstall.indexOf('Stop-ScheduledTask -TaskName $boot');
  const unregister=uninstall.indexOf('Unregister-ScheduledTask -TaskName $boot');
  const user=uninstall.indexOf('Enable-ScheduledTask -TaskName $user');
  assert.ok(names>=0 && names<guard && guard<stop && stop<unregister && unregister<user);
  assert.match(uninstall,/Get-ScheduledTask -TaskName \$boot -TaskPath/);
});

test('Hub Boot install checks protected root before any token access or task changes',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const install=src.indexOf('export async function installHubBootLifecycle(');
  const guard=src.indexOf('assertProtectedHubBootRoot(protectedBootRoot)',install);
  const secret=src.indexOf('readProtectedSecretFile(',install);
  const mkdir=src.indexOf('await fs.mkdir(',install);
  assert.ok(install>=0 && guard>install && secret>guard && mkdir>guard);
});
test('SYSTEM Hub Boot requires protected parent ACL before any credential read or task mutation',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const begin=src.indexOf('export async function installHubBootLifecycle(');
  const end=src.indexOf('export async function uninstallHubBootLifecycle(',begin);
  const install=src.slice(begin,end);
  const canonical=install.indexOf('assertProtectedHubBootRoot(protectedBootRoot)');
  const parentAcl=install.indexOf('verifyWindowsPrivateAcl(path.win32.dirname(protectedBootRoot))');
  const currentSecret=install.indexOf('readProtectedSecretFile(');
  const machineSecret=install.indexOf('writeProtectedSecretFile(');
  const register=install.indexOf('Register-ScheduledTask -TaskName $boot');
  assert.ok(begin>=0 && end>begin);
  assert.ok(canonical>=0 && canonical<parentAcl);
  assert.ok(parentAcl<currentSecret && currentSecret<machineSecret && machineSecret<register);
  assert.match(src,/import \{ hardenWindowsProgramDataAcl, verifyWindowsPrivateAcl \}/);
});

test('Hub Boot uninstall checks private parent ACL before task changes and again before deleting files',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const begin=src.indexOf('export async function uninstallHubBootLifecycle(');
  const end=src.indexOf('export async function runHubBootLifecycleCommand(',begin);
  const uninstall=src.slice(begin,end);
  const parent=uninstall.indexOf('const parent=path.win32.dirname(p.root)');
  const firstAcl=uninstall.indexOf('verifyWindowsPrivateAcl(parent)');
  const firstTree=uninstall.indexOf('await assertHubBootRootSafeToRemove(p.root)');
  const task=uninstall.indexOf('await runPowerShellJson<');
  const finalAcl=uninstall.indexOf('verifyWindowsPrivateAcl(parent)',firstAcl+1);
  const finalTree=uninstall.indexOf('await assertHubBootRootSafeToRemove(p.root)',firstTree+1);
  const remove=uninstall.indexOf('await fs.rm(p.root');
  assert.ok(parent>=0 && parent<firstAcl && firstAcl<firstTree);
  assert.ok(firstTree<task && task<finalAcl && finalAcl<finalTree && finalTree<remove);
  assert.match(uninstall,/verifyWindowsPrivateAcl\(parent\)/);
  assert.match(uninstall,/await assertHubBootRootSafeToRemove\(p.root\)/);
});

test('Hub Boot uninstall validates only its flat protected files before task or recursive deletion',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const uninstall=src.indexOf('export async function uninstallHubBootLifecycle(');
  const guard=src.indexOf('await assertHubBootRootSafeToRemove(p.root)',uninstall);
  const task=src.indexOf('await runPowerShellJson<',uninstall);
  const deletion=src.indexOf('await fs.rm(p.root',uninstall);
  assert.ok(uninstall>=0 && guard>uninstall && task>guard && deletion>task);
  assert.match(src,/if\(!item\.isFile\(\)\|\|item\.isSymbolicLink\(\)\|\|!allowed\.has\(item\.name\)\)/);
  assert.match(src,/HUB_BOOT_UNEXPECTED_REMOVAL_ENTRY/);
  assert.match(src,/HUB_BOOT_UNSAFE_REMOVAL_ROOT/);
});
