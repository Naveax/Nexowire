import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertProtectedHubBootRoot} from '../src/hub/hub-boot-lifecycle.js';

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

test('Hub Boot install checks protected root before any token access or task changes',()=>{
  const src=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const install=src.indexOf('export async function installHubBootLifecycle(');
  const guard=src.indexOf('assertProtectedHubBootRoot(pathsFor(options).root)',install);
  const secret=src.indexOf('readProtectedSecretFile(',install);
  const mkdir=src.indexOf('await fs.mkdir(',install);
  assert.ok(install>=0 && guard>install && secret>guard && mkdir>guard);
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
