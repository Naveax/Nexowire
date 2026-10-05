import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('authorized release publisher requires an exact version marker and preserves scoped permissions', async () => {
  const [workflow, readiness] = await Promise.all([
    fs.readFile(
      path.join(
        process.cwd(),
        '.github',
        'workflows',
        'publish-release.yml',
      ),
      'utf8',
    ),
    fs.readFile(
      path.join(
        process.cwd(),
        '.github',
        'workflows',
        'release-readiness.yml',
      ),
      'utf8',
    ),
  ]);

  assert.match(workflow, /paths:\n\s+- "\.github\/releases\/\*\.authorized"/);
  assert.match(workflow, /branches: \["main"\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);

  const authorize = workflow.slice(workflow.indexOf('\n  authorize:\n'));
  assert.match(authorize, /contents: write/);
  assert.match(authorize, /actions: write/);
  assert.match(authorize, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(authorize, /\.github\/releases\/\$\{TAG\}\.authorized/);
  assert.match(authorize, /EXPECTED="authorized-version=\$\{TAG\}"/);
  assert.match(authorize, /npm run release:check/);
  assert.match(authorize, /npm run release:tag:check/);
  assert.match(authorize, /git rev-list -n 1 "\$\{TAG\}"/);
  assert.match(authorize, /git push origin "\$\{TAG\}"/);
  assert.match(
    authorize,
    /actions\/workflows\/release-readiness\.yml\/runs\?branch=\$\{TAG\}&event=workflow_dispatch/,
  );
  assert.match(
    authorize,
    /\.head_sha == \\"\$\{GITHUB_SHA\}\\"/,
  );
  assert.match(
    authorize,
    /\.head_branch == \\"\$\{TAG\}\\"/,
  );
  assert.match(
    authorize,
    /Release Readiness already active or successful/,
  );
  assert.match(
    authorize,
    /gh workflow run release-readiness\.yml/,
  );
  assert.match(authorize, /--ref "\$\{TAG\}"/);
  assert.match(
    readiness,
    /push:\n\s+tags:\n\s+- "v\*"/,
  );
});
