import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry } from '../../../src/skills/registry.js';

// P013 / issue #780: deterministic owner-only fail-closed regression.
// This test is intentionally RED on owner source blob
// a95b619ca471ed0fcf951226ad9e9b07d124a19b at #1160 81028bf6.
// No production filesystem or actual external credentials are involved.
// It injects a reachable sequence of filesystem entry swaps at await points;
// it does not measure a natural concurrent attack or Windows behavior.
test('P013 SOURCE_RED: directory ABA between lstat, realpath and open must deny outside read', {
  skip: process.platform === 'win32'
    ? 'Linux symlink-only source repro; Windows reparse/SYSTEM acceptance owner-only'
    : false,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-k17-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-k17-outside-'));
  const name = 'bounded-skill';
  const slot = path.join(root, name);
  const parked = path.join(root, 'parked');
  const manifest = path.join(slot, 'SKILL.md');
  const native = { lstat: fs.lstat, realpath: fs.realpath, open: fs.open };
  let stage = 0;
  try {
    await fs.mkdir(slot);
    await fs.writeFile(manifest, `---\nname: ${name}\n---\nTRUSTED_CONTENT`);
    await fs.writeFile(path.join(outside, 'SKILL.md'),
      `---\nname: ${name}\n---\nEXTERNAL_MARKER`);
    const registry = new SkillRegistry(root);
    assert.match(await registry.read(name), /TRUSTED_CONTENT/);

    // Use real temporary filesystem renames/symlinks. The test-only wrappers
    // force the otherwise timing-sensitive parent directory entry ABA.
    fs.lstat = async function (p, ...args) {
      if (p === manifest && stage === 0) {
        await fs.rename(slot, parked);
        await fs.symlink(outside, slot, 'dir');
        stage = 1;
      }
      return native.lstat.call(fs, p, ...args);
    };
    fs.realpath = async function (p, ...args) {
      if (p === manifest && stage === 1) {
        await fs.unlink(slot);
        await fs.rename(parked, slot);
        stage = 2;
      }
      return native.realpath.call(fs, p, ...args);
    };
    fs.open = async function (p, ...args) {
      if (p === manifest && stage === 2) {
        await fs.rename(slot, parked);
        await fs.symlink(outside, slot, 'dir');
        stage = 3;
      }
      return native.open.call(fs, p, ...args);
    };

    // A correct owner repair may reject at an earlier check instead of
    // reaching all three interpositions. Rejection is a safe outcome, not RED.
    // If loading succeeds, insist that the whole hostile sequence ran;
    // otherwise an unexercised fixture could accidentally turn green.
    let markdown;
    let rejected = false;
    try {
      markdown = await registry.read(name);
    } catch (error) {
      assert.ok(error instanceof Error, 'Failure must be an explicit rejection');
      rejected = true;
    }
    assert.ok(stage >= 1, 'Hostile filesystem swap must be exercised');
    if (!rejected) {
      assert.equal(stage, 3, 'An accepted read must exercise lstat → realpath → open');
      assert.doesNotMatch(markdown, /EXTERNAL_MARKER/,
        'Opened file must stay inside the original trusted catalogue');
    }
  } finally {
    fs.lstat = native.lstat;
    fs.realpath = native.realpath;
    fs.open = native.open;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
