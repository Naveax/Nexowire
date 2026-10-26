import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';

// Read-only source negative: no ACL edits, no elevated process, no installed Broker.
function brokerTreeUnsafeRights(): {mask:number; expression:string; source:string} {
  const source=readFileSync(path.resolve('scripts/audit-core-broker-protected-tree.ps1'),'utf8');
  const match=/\$writeMask\s*=\s*\[int64\]\(([^)]*)\)/i.exec(source);
  assert.ok(match,'expected the canonical Broker-tree ACL mask expression');
  const expression=match[1]!.trim();
  assert.match(expression,/^0x[0-9a-f]+(?:\s+-bor\s+0x[0-9a-f]+)*$/i,
    'ACL unsafe-rights mask must contain only explicit literal OR terms');
  const mask=[...expression.matchAll(/0x[0-9a-f]+/gi)]
    .reduce((bits,m)=>bits|Number.parseInt(m[0],16),0);
  return {mask,expression,source};
}

test('QA02: low-trust DELETE_CHILD-only directory ACE is included in Broker-tree unsafe-rights mask',()=>{
  const {mask,source}=brokerTreeUnsafeRights();
  // FILE_DELETE_CHILD / FileSystemRights.DeleteSubdirectoriesAndFiles = 0x40.
  // Without it a directory ACE can permit removal of a protected child
  // despite not granting DELETE on that child file itself.
  assert.equal(mask&0x40,0x40,
    'low-trust DeleteSubdirectoriesAndFiles directory ACE was not detected');
  assert.match(source,/productionReady=\$false/,
    'a read-only ACL audit must never assert production readiness');
  assert.match(source,/nativeEffectiveLowPrivilegeAccessCheckCompleted=\$false/,
    'enumerating access rules is not a native effective AccessCheck');
});

test('QA02: real .NET FileSystemRights DELETE_CHILD value is recognized by the PowerShell mask', {
  skip:process.platform!=='win32',timeout:20000,
},()=>{
  const {expression}=brokerTreeUnsafeRights();
  // Evaluate only the validated hex literal expression against the Windows
  // CLR enum in-memory; this neither creates files nor changes Windows ACLs.
  const script=[
    "$ErrorActionPreference='Stop'",
    "$mask=[int64]("+expression+")",
    "$right=[int64][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles",
    "if($right -ne 64 -or (($mask -band $right) -ne $right)){throw 'QA02_DELETE_CHILD_NOT_FLAGGED'}",
    "[Console]::Out.Write('QA02_DELETE_CHILD_RECOGNIZED')",
  ].join(';');
  const result=spawnSync('pwsh.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:16000,maxBuffer:8192});
  assert.equal(result.status,0,
    'read-only native enum check failed: '+(result.stderr??'').slice(0,1000));
  assert.equal(result.stdout.trim(),'QA02_DELETE_CHILD_RECOGNIZED');
});
