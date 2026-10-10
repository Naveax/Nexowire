import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  startPrivilegedBrokerTask,
  stopPrivilegedBrokerTask,
} from '../src/agent/privileged-broker-lifecycle.js';
import { verifyWindowsPrivateAcl } from '../src/security/windows-programdata-acl.js';

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
    'verifyWindowsPrivateAcl(trustedRoot)',
    'verifyWindowsPrivateAcl(launcherPath(options))',
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
