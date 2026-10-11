import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';

const source=path.resolve('scripts/inspect-legacy-cutover-readiness.ps1');
const powershell=path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32','WindowsPowerShell','v1.0','powershell.exe');

test('readonly Task audit tests the actual protected action, not caller Launcher',{
  skip:process.platform!=='win32' || !existsSync(powershell),
},()=>{
  // AST extraction invokes only the pure function, not its parent script.
  const ps=String.raw`$ErrorActionPreference='Stop'
$tokens=$null
$errors=$null
$tree=[System.Management.Automation.Language.Parser]::ParseFile('__SCRIPT__',[ref]$tokens,[ref]$errors)
if($errors.Count -gt 0){throw 'POWERSHELL_SYNTAX_INVALID'}
$funcs=@($tree.FindAll({
 param($ast)
 $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
 $ast.Name -eq 'TestProtectedStackTaskAction'
},$true))
if($funcs.Count -ne 1){throw 'UNIQUE_ACTION_VALIDATOR_MISSING'}
. ([scriptblock]::Create($funcs[0].Extent.Text))
$root='C:\ProgramData\NexowireStack'
$exe='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$expected='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$root+'\run-stack.ps1"'
$cases=@(
 @{name='protected';exe=$exe;arg=$expected;cwd=$root},
 @{name='unqualified';exe='powershell.exe';arg=$expected;cwd=$root},
 @{name='wow64';exe='C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe';arg=$expected;cwd=$root},
 @{name='profile-file';exe=$exe;arg='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\alice\AppData\Local\run-stack.ps1"';cwd=$root},
 @{name='quoted-decoy';exe=$exe;arg='-NoProfile -Command "Write-Host -NonInteractive -File C:\ProgramData\NexowireStack\run-stack.ps1"';cwd=$root},
 @{name='extra-switch';exe=$exe;arg=($expected+' -EncodedCommand ABC');cwd=$root},
 @{name='different-script';exe=$exe;arg=$expected.Replace('run-stack.ps1','run-stack.ps1.bak');cwd=$root},
 @{name='missing-noninteractive';exe=$exe;arg=$expected.Replace(' -NonInteractive','');cwd=$root},
 @{name='profile-cwd';exe=$exe;arg=$expected;cwd='C:\Users\alice\AppData\Local'},
 @{name='blank-cwd';exe=$exe;arg=$expected;cwd=''}
)
$out=@(foreach($case in $cases){
 $r=TestProtectedStackTaskAction ([pscustomobject]@{
  Execute=$case.exe;Arguments=$case.arg;WorkingDirectory=$case.cwd
 })
 [pscustomobject]@{
  name=$case.name
  canonical=$r.canonicalProtectedAction
  interpreter=$r.system32PowerShellPinned
  protectedLauncher=$r.launcherUnderProtectedStack
  nonInteractive=$r.nonInteractive
  protectedCwd=$r.protectedWorkingDirectory
 }
})
ConvertTo-Json -InputObject $out -Compress -Depth 4
`.replace('__SCRIPT__',source.replaceAll("'","''"));
  const run=spawnSync(powershell,
    ['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(ps,'utf16le').toString('base64')],
    {encoding:'utf8',timeout:20000,windowsHide:true});
  assert.equal(run.status,0,run.stderr+'\n'+run.stdout);
  const output=JSON.parse(run.stdout) as Array<{
    name:string;canonical:boolean;interpreter:boolean;
    protectedLauncher:boolean;nonInteractive:boolean;protectedCwd:boolean
  }>;
  assert.equal(output.length,10);
  const good=output.find(c=>c.name==='protected')!;
  assert.deepEqual(good,{
    name:'protected',canonical:true,interpreter:true,
    protectedLauncher:true,nonInteractive:true,protectedCwd:true,
  });
  for(const current of output.filter(c=>c.name!=='protected')){
    assert.equal(current.canonical,false,current.name);
  }
  for(const name of ['profile-file','quoted-decoy','extra-switch',
    'different-script','missing-noninteractive']){
    const actual=output.find(c=>c.name===name)!;
    assert.equal(actual.protectedLauncher,false,name);
    assert.equal(actual.nonInteractive,false,name);
  }
  assert.equal(output.find(c=>c.name==='unqualified')?.interpreter,false);
  assert.equal(output.find(c=>c.name==='profile-cwd')?.protectedCwd,false);
});
