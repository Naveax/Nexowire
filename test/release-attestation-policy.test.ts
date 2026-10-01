import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('release attestation permissions stay isolated to explicit tag pushes', async () => {
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

  const attest = workflow.slice(index);
  assert.match(
    attest,
    /if: github\.event_name == 'push' && github\.ref_type == 'tag'/,
  );
  assert.match(attest, /needs: package/);
  assert.match(attest, /actions: read/);
  assert.match(attest, /contents: read/);
  assert.match(attest, /id-token: write/);
  assert.match(attest, /attestations: write/);
  assert.match(attest, /artifact-metadata: write/);
  assert.match(attest, /actions\/download-artifact@v4/);
  assert.match(attest, /sha256sum -c SHA256SUMS/);

  const uses = attest.match(/uses: actions\/attest@v4/g) ?? [];
  assert.equal(uses.length, 2);
  assert.match(
    attest,
    /subject-path: "release-candidate\/nexowire-\*\.tgz"/,
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
});
