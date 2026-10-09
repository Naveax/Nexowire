import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {assertFreshMachineUpdateTarget} from '../src/update/machine-update.js';

test('missing target is eligible for first extraction; existing directory is never silently reused',async()=>{
  const fixture=mkdtempSync(path.join(tmpdir(),'nx-target-provenance-'));
  try{
    const target=path.join(fixture,'versions','1.0.5-012345abcdef');
    await assert.doesNotReject(()=>assertFreshMachineUpdateTarget(target));
    mkdirSync(target,{recursive:true});
    await assert.rejects(()=>assertFreshMachineUpdateTarget(target),
      /MACHINE_UPDATE_EXISTING_TARGET_UNATTESTED/);
    writeFileSync(path.join(target,'node.exe'),'untrusted');
    writeFileSync(path.join(target,'cli.js'),'modified');
    await assert.rejects(()=>assertFreshMachineUpdateTarget(target),
      /MACHINE_UPDATE_EXISTING_TARGET_UNATTESTED/);
  } finally {
    rmSync(fixture,{recursive:true,force:true});
  }
});

test('a preexisting file or dangling invalid target is not implicitly trusted',async()=>{
  const fixture=mkdtempSync(path.join(tmpdir(),'nx-target-collision-'));
  try{
    const target=path.join(fixture,'version-target');
    writeFileSync(target,'not-a-directory');
    await assert.rejects(()=>assertFreshMachineUpdateTarget(target),
      /MACHINE_UPDATE_EXISTING_TARGET_UNATTESTED/);
  } finally{
    rmSync(fixture,{recursive:true,force:true});
  }
});

test('updated machine updater refuses target reuse before staging or recursive mutation and at promotion',()=>{
  const source=readFileSync(new URL('../src/update/machine-update.ts',import.meta.url),'utf8');
  const begin=source.indexOf('async function extractVerifiedRuntime(');
  const first=source.indexOf('await assertFreshMachineUpdateTarget(target)',begin);
  const mkdir=source.indexOf('await fs.mkdir(versions',begin);
  const stage=source.indexOf('await fs.writeFile(zipFile, zipBuffer)',begin);
  const second=source.indexOf('await assertFreshMachineUpdateTarget(target)',first+1);
  const rename=source.indexOf('await fs.rename(source,target)',begin);
  assert.ok(begin>=0&&first>begin&&first<mkdir&&mkdir<stage);
  assert.ok(second>stage&&second<rename);
  assert.doesNotMatch(source.slice(begin,rename),/await fs\.access\(targetNode\)/);
  assert.doesNotMatch(source.slice(begin,rename),/await fs\.access\(targetCli\)/);
  assert.match(source.slice(begin,rename),/MACHINE_UPDATE_EXISTING_TARGET_UNATTESTED|assertFreshMachineUpdateTarget/);
});
