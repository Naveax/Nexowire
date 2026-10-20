import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {parseOfflineReleaseArgs} from '../scripts/verify-s3-release-bundle.js';

test('release preflight CLI requires exact three independently pinned arguments',()=>{
  const args=['--trusted-policy','C:\\trusted\\policy.json',
    '--policy-sha256','a'.repeat(64),'--bundle-root','C:\\isolated\\release'];
  assert.deepEqual(parseOfflineReleaseArgs(args),{
    trustedPolicyPath:'C:\\trusted\\policy.json',
    trustedPolicySha256:'a'.repeat(64),bundleRoot:'C:\\isolated\\release',
  });
  for(const invalid of [
    [],args.slice(0,4),[...args,'--execute','yes'],
    [...args.slice(0,4),'--trusted-policy','duplicate'],
    ['--trusted-policy','C:\\a','--policy-sha256','a'.repeat(64),
      '--execute','C:\\x'],
    ['--trusted-policy','--untrusted','--policy-sha256','a'.repeat(64),
      '--bundle-root','C:\\x'],
  ]) assert.throws(()=>parseOfflineReleaseArgs(invalid),/S3_OFFLINE_ARGS_INVALID/);
});

test('no policy/proof means CLI exits nonzero without service or installer launch',()=>{
  const result=spawnSync(process.execPath,[
    '--import','tsx','scripts/verify-s3-release-bundle.ts',
    '--trusted-policy','C:\\MISSING\\operator-policy.json',
    '--policy-sha256','a'.repeat(64),
    '--bundle-root','C:\\MISSING\\bundle',
  ],{cwd:process.cwd(),shell:false,windowsHide:true,encoding:'utf8',
    timeout:15000,maxBuffer:4096});
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/S3_OFFLINE_UNVERIFIED|S3_OFFLINE_/);
  assert.doesNotMatch(result.stderr,/C:\\MISSING|operator-policy\.json/i);
});
