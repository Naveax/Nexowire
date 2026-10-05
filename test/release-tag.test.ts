import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  checkCurrentReleaseTag,
  checkReleaseTag,
} from '../scripts/check-release-tag.js';

test('release tag policy is inert on branch and pull-request refs', () => {
  assert.deepEqual(
    checkReleaseTag({
      packageVersion: '1.2.3',
      refType: 'branch',
      refName: 'main',
    }),
    {
      checked: false,
      refType: 'branch',
      refName: 'main',
      packageVersion: '1.2.3',
      expectedTag: 'v1.2.3',
    },
  );
});

test('release tag policy accepts only the exact v-prefixed package version', () => {
  assert.equal(
    checkReleaseTag({
      packageVersion: '1.0.0',
      refType: 'tag',
      refName: 'v1.0.0',
    }).checked,
    true,
  );

  assert.throws(
    () =>
      checkReleaseTag({
        packageVersion: '1.0.0',
        refType: 'tag',
        refName: 'v1.0.0-rc.1',
      }),
    /does not match package version/,
  );

  assert.throws(
    () =>
      checkReleaseTag({
        packageVersion: '1.0.0',
        refType: 'tag',
        refName: null,
      }),
    /GITHUB_REF_NAME is missing/,
  );
});

test('current release tag policy reads package.json and GitHub ref environment', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    ),
  ) as { version: string };

  const result = await checkCurrentReleaseTag({
    rootDir: process.cwd(),
    env: {
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: `v${packageJson.version}`,
    },
  });
  assert.equal(result.checked, true);
  assert.equal(result.packageVersion, packageJson.version);
});
