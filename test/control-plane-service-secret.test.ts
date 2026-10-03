import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import {
  writeProtectedSecretFile,
} from '../src/security/protected-secret-files.js';

test(
  'Windows Hub resolves the control-plane service token from a purpose-bound DPAPI envelope',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'nexowire-control-plane-secret-',
      ),
    );
    const file = path.join(
      dir,
      'control-plane-service.dpapi.json',
    );
    const secret =
      'service-token-dpapi-test-0123456789';

    try {
      await writeProtectedSecretFile(
        file,
        'control-plane-service-token',
        secret,
        { overwrite: false },
      );

      const config = loadConfig({
        NEXOWIRE_CONTROL_PLANE_URL:
          'https://control.example.test',
        NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:
          file,
      });

      assert.equal(
        config.controlPlaneAgentAuth?.serviceToken,
        secret,
      );
      assert.equal(
        config.controlPlaneAgentAuth?.url,
        'https://control.example.test',
      );

      const envelope =
        await fs.readFile(file, 'utf8');
      assert.equal(
        envelope.includes(secret),
        false,
      );
      assert.match(
        envelope,
        /windows-dpapi-current-user/,
      );
      assert.match(
        envelope,
        /control-plane-service-token/,
      );
    } finally {
      await fs.rm(dir, {
        recursive: true,
        force: true,
      });
    }
  },
);
