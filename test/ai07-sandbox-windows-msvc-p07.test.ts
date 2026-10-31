import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Disposable native compiler/negative CLI acceptance, not task execution.
 * This file is an AI-07 test for coordinator Windows runners. On another OS,
 * it is explicitly unsupported, never physical PASS.
 * No registry, UAC, ACL, service, installed Agent or shared target mutation.
 */
const nativePath=fileURLToPath(new URL(
  '../native/task-os-sandbox-windows-token-job-readback-p07.c', import.meta.url,
));
test('AI-07 MSVC native build and reject non-selftest task input', {
  skip: process.platform !== 'win32' ? 'Windows-only native test; physical verdict NOT_RUN' : false,
  timeout: 90000,
}, () => {
  const programFiles=process.env['ProgramFiles(x86)'];
  assert.ok(programFiles, 'BLOCKED: Windows ProgramFiles(x86) missing');
  const vswhere=path.join(programFiles!,
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  assert.ok(existsSync(vswhere), 'BLOCKED: vswhere/MSVC not installed');
  const found=spawnSync(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath'], {
      encoding:'utf8', windowsHide:true, timeout:15000,
    });
  assert.equal(found.status,0,String(found.stderr || found.error));
  const install=found.stdout.trim().split(/\r?\n/)[0];
  assert.ok(install, 'BLOCKED: MSVC C++ toolchain unavailable');
  const vcvars=path.join(install, 'VC','Auxiliary','Build','vcvars64.bat');
  assert.ok(existsSync(vcvars), 'BLOCKED: MSVC x64 build environment unavailable');
  const dir=mkdtempSync(path.join(tmpdir(),'nw07-native-msvc-'));
  try {
    const output=path.join(dir,'nw07-probe.exe');
    const obj=path.join(dir,'nw07-probe.obj');
    const command='"'+vcvars+'" >nul && cl.exe /nologo /W4 /WX /utf-8 '+
      '/Fo:"'+obj+'" /Fe:"'+output+'" "'+nativePath+'" Advapi32.lib';
    const compiled=spawnSync('cmd.exe',['/d','/s','/c',command],{
      encoding:'utf8', windowsHide:true, timeout:65000,
      maxBuffer: 1024*1024,
    });
    assert.equal(compiled.status,0,
      'BLOCKED: MSVC warning/error: '+String(compiled.error||compiled.stderr||compiled.stdout));
    assert.ok(existsSync(output),'BLOCKED: no compiled probe');
    const denied=spawnSync(output,['--run','cmd.exe','/c','whoami'],{
      encoding:'utf8', windowsHide:true,timeout:5000,
    });
    assert.equal(denied.status,64,String(denied.stderr||denied.error));
    assert.match(denied.stderr,/NW07_SOURCE_ONLY_NO_TASK_EXEC/);
    const empty=spawnSync(output,[],{encoding:'utf8',windowsHide:true,timeout:5000});
    assert.equal(empty.status,64,String(empty.stderr||empty.error));
    const normal=spawnSync(output,['--selftest-only'],{
      encoding:'utf8',windowsHide:true,timeout:10000,
    });
    assert.equal(normal.status,77,
      'Ordinary runner must not impersonate an AppContainer+Job worker: '+
      String(normal.stdout||normal.stderr||normal.error));
    assert.match(normal.stderr,/NW07_WINDOWS_BOUNDARY_NOT_PROVEN/);
  } finally {
    rmSync(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100});
  }
});
