import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBundleArgs,
  renderHiddenLauncher,
  renderSetupScript,
} from '../scripts/build-windows-user-bundle.js';

const sourceSha =
  '436b84c89454db592257fd549fdc65cbbd036d1e';
const payloadSha =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('Windows bundle parser keeps repository and source inputs bounded', () => {
  const parsed = parseBundleArgs(
    [
      '--output-dir',
      'out',
      '--repository',
      'Naveax/Nexowire',
      '--node-version',
      '24.15.0',
      '--source-sha',
      sourceSha,
    ],
    {},
  );

  assert.equal(parsed.repository, 'Naveax/Nexowire');
  assert.equal(parsed.nodeVersion, '24.15.0');
  assert.equal(parsed.sourceSha, sourceSha);
  assert.match(parsed.outputDir, /out$/);

  assert.throws(
    () =>
      parseBundleArgs(
        ['--repository', 'bad repo'],
        { GITHUB_SHA: sourceSha },
      ),
    /Invalid GitHub repository/,
  );
  assert.throws(
    () =>
      parseBundleArgs(
        ['--source-sha', 'not-a-sha'],
        {},
      ),
    /Invalid source SHA/,
  );
  assert.throws(
    () =>
      parseBundleArgs(
        ['--wat', 'x'],
        { GITHUB_SHA: sourceSha },
      ),
    /Unknown Windows bundle option/,
  );
});

test('hidden Windows launcher opens only the simple connect flow', () => {
  const launcher = renderHiddenLauncher();
  assert.match(launcher, /runtime\\node\.exe/);
  assert.match(launcher, /dist\\src\\cli\.js/);
  assert.match(launcher, /" connect"/);
  assert.match(launcher, /shell\.Run command, 0, False/);
  assert.doesNotMatch(
    launcher,
    /control-plane-url|token|tailscale|console_control/i,
  );
});

test('Windows setup is non-admin, versioned, and checksum-pinned', () => {
  const setup = renderSetupScript({
    version: '1.0.1',
    sourceSha,
    payloadSha256: payloadSha,
    repository: 'Naveax/Nexowire',
  });

  assert.match(
    setup,
    /releases\/download\/v1\.0\.1\/Nexowire-Windows-x64\.zip/,
  );
  assert.match(setup, new RegExp(payloadSha));
  assert.match(
    setup,
    /Nexowire\\versions\\%NX_BUILD_ID%/,
  );
  assert.match(setup, /1\.0\.1-436b84c89454/);
  assert.match(setup, /Get-FileHash .* SHA256/);
  assert.match(setup, /Nexowire\.lnk/);
  assert.match(setup, /wscript\.exe/);
  assert.doesNotMatch(
    setup,
    /-Verb\s+RunAs|runas\.exe|requireAdministrator/i,
  );
  assert.doesNotMatch(
    setup,
    /bearer|credential|api[_ -]?key|secret/i,
  );
});
