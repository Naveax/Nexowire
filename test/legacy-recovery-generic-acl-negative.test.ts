import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const script=readFileSync(new URL('../scripts/backup-legacy-scheduled-task.ps1',import.meta.url),'utf8');

test('DPAPI legacy task recovery ACL denies Windows generic writes and metadata rewrites',()=>{
 const start=script.indexOf('$writeMask=(');
 const end=script.indexOf('function Check-SafePath(',start);
 assert.ok(start>=0&&end>start,'recovery ACL mask missing');
 const mask=script.slice(start,end);
 assert.match(mask,/WriteExtendedAttributes/);
 assert.match(mask,/WriteAttributes/);
 assert.match(mask,/\[int64\]0x40000000/);
 assert.match(mask,/\[int64\]0x10000000/);
 assert.match(script,/\[int64\]\$ace\.FileSystemRights -band \$writeMask/);
 assert.match(script,/\$ace\.PropagationFlags[\s\S]*?InheritOnly/);
 assert.match(script,/RECOVERY_OWNER_UNTRUSTED/);
 assert.match(script,/RECOVERY_UNTRUSTED_WRITE_GRANT/);
 assert.doesNotMatch(script,/Register-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|Set-Acl|icacls\.exe/);
});

test('safe legacy backup parses without task mutation on real Windows',{
 skip:process.platform!=='win32',timeout:30000,
},()=>{
 const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
 const path=new URL('../scripts/backup-legacy-scheduled-task.ps1',import.meta.url).pathname.replace(/^\//,'').replaceAll('/','\\');
 const cmd='$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile('+
  String.raw`'`+path.replaceAll("'","''")+String.raw`'`+', [ref]$t,[ref]$e)|Out-Null;if($e.Count){exit 9}';
 const result=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',cmd],
  {windowsHide:true,encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stderr);
});
