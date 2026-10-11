import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  startPrivilegedBrokerTask,
  stopPrivilegedBrokerTask,
} from '../src/agent/privileged-broker-lifecycle.js';
import { verifyWindowsPrivateAcl } from '../src/security/windows-programdata-acl.js';
import { inspectPrivilegedStackSourceChainReadOnly } from '../src/security/privileged-stack-source-audit.js';

const source=readFileSync(new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8');

test('Broker startup verifies protected ACLs, while emergency stop remains possible',()=>{
  const guard=source.indexOf('async function verifyBrokerTaskStartFiles');
  const start=source.indexOf('export async function startPrivilegedBrokerTask');
  const stop=source.indexOf('export async function stopPrivilegedBrokerTask');
  const nextOperation=source.indexOf('export type PrivilegedBrokerDesiredMode');
  assert.ok(guard>=0 && guard<start && start<stop && stop<nextOperation);
  const preflight=source.slice(guard,start);
  const list=[
    'assertBrokerRootSafeToRemove(trustedRoot)',
    'inspectPrivilegedStackSourceChainReadOnly([',
    'path.win32.dirname(trustedRoot),trustedRoot,launcherPath(options)',
    '],verifyWindowsPrivateAcl)',
  ];
  let previous=-1;
  for (const token of list) {
    const at=preflight.indexOf(token);
    assert.ok(at>previous,token);
    previous=at;
  }
  const startOperation=source.slice(start,stop);
  const stopOperation=source.slice(stop,nextOperation);
  assert.ok(startOperation.indexOf('await verifyBrokerTaskStartFiles(options)') >= 0);
  assert.ok(startOperation.indexOf('await verifyBrokerTaskStartFiles(options)') <
    startOperation.indexOf('Get-ScheduledTask -TaskName $name -ErrorAction Stop'));
  // An unsafe ACL must block starting but cannot prevent emergency stopping.
  assert.doesNotMatch(stopOperation,/verifyBrokerTaskStartFiles\(options\)/);
  assert.match(stopOperation,/privilegedBrokerTaskControlPreflightScript/);
  assert.match(stopOperation,/Stop-ScheduledTask -TaskName \$name -ErrorAction Stop/);
  assert.doesNotMatch(preflight,/hardenWindowsProgramDataAcl/);
});

test('elevated Broker install verifies protected parent before persisting any secret or task',()=>{
  const begin=source.indexOf('export async function installPrivilegedBrokerTask');
  const end=source.indexOf('/** Fail closed before operating on an elevated scheduled task.');
  const installer=source.slice(begin,end);
  const parent=installer.indexOf('verifyWindowsPrivateAcl(path.win32.dirname(directory))');
  const secret=installer.indexOf('await loadOrCreatePrivilegedBrokerToken(');
  const write=installer.indexOf('await fs.writeFile(');
  const register=installer.indexOf('Register-ScheduledTask -TaskName $name');
  assert.ok(parent>=0 && secret>parent && write>secret && register>write);
});

test('Broker start preflight source chain detects parent and launcher changes during ACL audit',()=>{
  for(const change of ['parent','launcher'] as const){
    const parent=mkdtempSync(path.join(tmpdir(),'nwx-broker-parent-'));
    const broker=path.join(parent,'privileged-broker');
    mkdirSync(broker);
    const launcher=path.join(broker,'launch.ps1');
    writeFileSync(launcher,'# trusted fixture');
    try{
      const checked:string[]=[];
      assert.throws(()=>inspectPrivilegedStackSourceChainReadOnly(
        [parent,broker,launcher],p=>{
          checked.push(p);
          if(p!==launcher)return;
          if(change==='parent')writeFileSync(path.join(parent,'unreviewed.txt'),'new');
          else writeFileSync(launcher,'# changed during ACL');
        },
      ),/PRIVILEGED_STACK_SOURCE_CHANGED_DURING_AUDIT/,change);
      assert.deepEqual(checked,[parent,broker,launcher]);
    }finally{rmSync(parent,{recursive:true,force:true})}
  }
});

test('Non-Windows Broker lifecycle mutations reject before invoking ScheduledTasks', {
  skip: process.platform==='win32',
},async()=>{
  await assert.rejects(startPrivilegedBrokerTask(),/only on Windows/);
  await assert.rejects(stopPrivilegedBrokerTask(),/only on Windows/);
});

test('Unauthorized Broker root override is rejected before task lookup', {
  skip:process.platform!=='win32',
},async()=>{
  const options={rootDir:'C:\\Users\\untrusted\\broker'};
  await assert.rejects(startPrivilegedBrokerTask(options),/UNTRUSTED_PROTECTED_ROOT/);
  await assert.rejects(stopPrivilegedBrokerTask(options),/UNTRUSTED_PROTECTED_ROOT/);
});

test('Read-only Windows ACL verifier rejects a temporary user-owned launcher', {
  skip:process.platform!=='win32',
},()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nwx-untrusted-broker-'));
  try {
    const file=path.join(dir,'launch.ps1');
    writeFileSync(file,'# inert test file\n');
    assert.throws(()=>verifyWindowsPrivateAcl(file),/PROTECTED_ACL_INTEGRITY_FAILURE/);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
