import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  TRUSTED_MACHINE_UPDATE_TREE,
  isolatedMachineUpdateAuditEnv,
  machineUpdateRootAuditSucceeded,
  inspectExistingMachineUpdateTreeReadOnly,
} from '../src/security/windows-machine-update-tree-trust.js';

test('machine updater read-only ACL auditor uses fixed Windows executable environment',()=>{
  assert.equal(TRUSTED_MACHINE_UPDATE_TREE,'C:\\ProgramData\\Nexowire');
  const env=isolatedMachineUpdateAuditEnv(TRUSTED_MACHINE_UPDATE_TREE);
  assert.deepEqual(env,{
    SystemRoot:'C:\\Windows',windir:'C:\\Windows',
    ComSpec:'C:\\Windows\\System32\\cmd.exe',
    PATH:'C:\\Windows\\System32;C:\\Windows',
    PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    NEXOWIRE_MACHINE_AUDIT_ROOT:'C:\\ProgramData\\Nexowire',
  });
  for(const key of ['NODE_OPTIONS','NODE_PATH','APPDATA','TEMP','USERPROFILE','GH_HOST'])
    assert.equal((env as NodeJS.ProcessEnv)[key],undefined);
});

test('root audit accepts exactly one clean marker with normal successful termination',()=>{
  assert.equal(machineUpdateRootAuditSucceeded({
    error:null,status:0,stdout:'PROTECTED_MACHINE_UPDATE_TREE\r\n',
  }),true);
  for(const input of [
    {error:new Error('untrusted'),status:0,stdout:'PROTECTED_MACHINE_UPDATE_TREE'},
    {error:null,status:1,stdout:'PROTECTED_MACHINE_UPDATE_TREE'},
    {error:null,status:0,stdout:'PROTECTED_MACHINE_UPDATE_TREE\nTRUE'},
    {error:null,status:0,stdout:'false'},
    {error:null,status:null,stdout:null},
  ])assert.equal(machineUpdateRootAuditSucceeded(input),false);
});

test('machine updater privileged gates run before staging and before detached cutover',()=>{
  const source=readFileSync(new URL('../src/update/machine-update.ts',import.meta.url),'utf8');
  const task=source.indexOf('export async function scheduleOfficialMachineUpdate(');
  const validate=source.indexOf('  const input = validateInput(rawInput);',task);
  const preflight=source.indexOf('  assertMachineUpdateTreeProtectedBeforeWrite();',task);
  const stage=source.indexOf('  const targetRoot = await extractVerifiedRuntime(input);',task);
  const postflight=source.indexOf('  assertMachineUpdateTreeProtectedBeforeWrite();',stage);
  const sign=source.indexOf('  assertWindowsPrivilegedRuntimeTrusted({',stage);
  const helperWrite=source.indexOf('  await fs.writeFile(',stage);
  const finalGuard=source.lastIndexOf('  assertMachineUpdateTreeProtectedBeforeWrite();');
  const start=source.indexOf('  const child = spawn(',stage);
  assert.ok(validate>=task&&validate<preflight&&preflight<stage);
  assert.ok(stage<postflight&&postflight<sign&&sign<helperWrite);
  assert.ok(helperWrite<finalGuard&&finalGuard<start);
  assert.ok(source.includes("executable:path.win32.join(targetRoot,'runtime','node.exe')"));
  assert.ok(source.includes("cliEntrypoint:path.win32.join(targetRoot,'app','dist','src','cli.js')"));
});

test('read-only root audit accepts an OS-protected inbox Security module',{
  skip:process.platform!=='win32',
},()=>{
  const trusted='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security';
  assert.equal(inspectExistingMachineUpdateTreeReadOnly(trusted),true);
});

test('real Windows root ACL audit rejects user-writable isolated fixture without mutation',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(path.join(tmpdir(),'nexowire-root-audit-user-writable-'));
  const oldPath=process.env.PATH;
  const oldModules=process.env.PSModulePath;
  try{
    process.env.PATH=root+';'+(oldPath||'');
    process.env.PSModulePath=root;
    assert.equal(inspectExistingMachineUpdateTreeReadOnly(root),false);
  } finally {
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldModules===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldModules;
    rmSync(root,{recursive:true,force:true});
  }
});
