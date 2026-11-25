import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOfflineRecoveryEvidence} from '../../scripts/ai02-offline-recovery-evidence.js';

test('coordinated uninstall cannot treat two missing transaction identities as equal',async()=>{
  type Input=Parameters<typeof collectOfflineRecoveryEvidence>[0];
  const input={
    purpose:'coordinated-uninstall-review',
    approved:{treeSha256:'a'.repeat(64),sqliteRecords:0,runtimeManifestSha256:'b'.repeat(64)},
    currentOfflineRoot:'not-a-valid-offline-root',
    preservedOfflineRoot:'not-a-valid-preserved-root',
    terminalReceipt:{bytes:Buffer.from('{"phase":"ROLLED_BACK"}'),expected:{}},
  } as unknown as Input;
  // Rejection must precede candidate review, filesystem access, or task proof.
  await assert.rejects(collectOfflineRecoveryEvidence(input),
    /AI02_OFFLINE_RECOVERY_RECEIPT_IDENTITY_UNVERIFIED/);
});
