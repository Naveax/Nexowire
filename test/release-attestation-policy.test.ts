import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('release attestation and publication stay isolated to explicit tag-scoped runs', async () => {
  const workflow = await fs.readFile(
    path.join(
      process.cwd(),
      '.github',
      'workflows',
      'release-readiness.yml',
    ),
    'utf8',
  );

  const marker = '\n  attest:\n';
  const index = workflow.indexOf(marker);
  assert.ok(index >= 0, 'attest job must exist');

  const publishMarker = '\n  publish:\n';
  const publishIndex = workflow.indexOf(publishMarker);
  assert.ok(publishIndex > index, 'publish job must follow attest');

  const attest = workflow.slice(index, publishIndex);
  assert.match(
    attest,
    /if: github\.ref_type == 'tag' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)/,
  );
  assert.match(attest, /needs: package/);
  assert.match(attest, /actions: read/);
  assert.match(attest, /contents: read/);
  assert.match(attest, /id-token: write/);
  assert.match(attest, /attestations: write/);
  assert.match(attest, /artifact-metadata: write/);
  assert.match(attest, /actions\/download-artifact@v4/);
  assert.match(attest, /sha256sum -c SHA256SUMS/);
  assert.match(attest, /sha256sum -c SHA256SUMS-Windows/);
  assert.match(attest, /nexowire-windows-\$\{\{ github\.run_id \}\}-\$\{\{ github\.sha \}\}/);

  const uses = attest.match(/uses: actions\/attest@v4/g) ?? [];
  assert.equal(uses.length, 4);
  assert.match(
    attest,
    /subject-path: "release-candidate\/nexowire-\*\.tgz"/,
  );
  assert.match(
    attest,
    /subject-path: "release-windows\/Nexowire-Windows-x64\.zip"/,
  );
  assert.match(
    attest,
    /subject-path: "release-windows\/Nexowire-Setup\.cmd"/,
  );
  assert.match(
    attest,
    /sbom-path: "release-candidate\/nexowire-sbom\.cdx\.json"/,
  );

  const packageJob = workflow.slice(
    workflow.indexOf('\n  package:\n'),
    index,
  );
  assert.doesNotMatch(packageJob, /id-token: write/);
  assert.doesNotMatch(packageJob, /attestations: write/);
  assert.doesNotMatch(packageJob, /artifact-metadata: write/);

  const publish = workflow.slice(publishIndex);
  assert.match(
    publish,
    /if: github\.ref_type == 'tag' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)/,
  );
  assert.match(publish, /needs: \[package, attest\]/);
  assert.match(publish, /actions: read/);
  assert.match(publish, /contents: write/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /sha256sum -c SHA256SUMS/);
  assert.match(publish, /sha256sum -c SHA256SUMS-Windows/);
  assert.match(publish, /gh release create/);
  assert.match(publish, /Nexowire-Setup\.cmd/);
  assert.match(publish, /Nexowire-Windows-x64\.zip/);
  assert.match(publish, /--verify-tag/);
  assert.doesNotMatch(publish, /id-token: write/);
  assert.doesNotMatch(publish, /attestations: write/);
});

