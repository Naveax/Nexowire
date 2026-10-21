import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNativeProtectedFileBoundary } from '../src/agent/windows-native-file-source-boundary.js';
import {
  syntheticProtectedBoundary,
  syntheticSource,
  syntheticDestination,
} from './p05-native-boundary-fixtures.js';

// #26 independent source-contract gap regression against owner #707.
// No OS ACL is read/modified: all identities, paths and ACEs below are synthetic.
// This test MUST NOT be described as a real Windows DACL or exploit witness.
test('W26/#707 gap: retained intermediate import ancestor has no mandatory handle-bound effective ACL', () => {
  const fixture = syntheticProtectedBoundary();
  const root = fixture.protectedImportGraph.observed.find(node => node.key === 'root');
  assert.ok(root, 'owner fixture must include protected installed import root');

  const intermediate = root.parentRelativeChain.steps[0];
  assert.ok(intermediate, 'source path has an intermediate privileged-broker directory');
  assert.equal(intermediate.child.objectType, 'directory');
  assert.equal(intermediate.child.noFollowVerified, true);
  assert.equal(intermediate.child.reparseTag, null);
  assert.equal(Object.hasOwn(intermediate.child, 'effectiveAcl'), false,
    'native relative step contract does not carry an independently attested DACL');

  const inspect = () => assertNativeProtectedFileBoundary(
    syntheticSource,
    syntheticDestination,
    'write',
    'trusted-owner',
    'trusted-device',
    fixture,
  );
  assert.doesNotThrow(inspect, 'reference synthetic #707 witness is accepted');

  // A deliberately hostile, test-only intermediate-directory DACL is
  // *unrecognized* in the current schema, so the returned positive result is
  // a missing-evidence-model finding. We are NOT proving any real ancestor
  // has this ACL, or that a real provider would return these fields.
  Object.assign(intermediate.child, {
    effectiveAcl: {
      provider: 'unavailable',
      observedFileId: intermediate.child.fileId,
      ownerSid: 'S-1-5-11',
      daclProtected: false,
      ancestorsVerified: false,
      descendantsVerified: false,
      aces: [
        { sid: 'S-1-5-11', type: 'allow', accessMask: 0x00040000, inheritOnly: false },
      ],
    },
  });
  assert.doesNotThrow(inspect,
    'owner #707 has no per-intermediate-directory effective ACL field to reject');
});
