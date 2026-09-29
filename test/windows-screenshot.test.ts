import test from 'node:test';
import assert from 'node:assert/strict';
import { captureWindowsScreenshot } from '../src/agent/windows-screenshot.js';
import { executeWindowsWindowCapability } from '../src/agent/windows-window-control.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

test(
  'Windows primary-screen screenshot returns a bounded valid PNG',
  { skip: process.platform !== 'win32' },
  async (t) => {
    let result;
    try {
      result = await captureWindowsScreenshot({
        source: 'primary_screen',
        max_width: 640,
        max_height: 480,
        max_bytes: 2_097_152,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'SCREENSHOT_DESKTOP_UNAVAILABLE'
      ) {
        t.skip('Runner has no capturable interactive desktop.');
        return;
      }
      throw error;
    }

    const image = result.data;
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.width > 0 && image.width <= 640);
    assert.ok(image.height > 0 && image.height <= 480);
    assert.ok(image.bytes > 64 && image.bytes <= 2_097_152);
    assert.match(image.sha256, /^[a-f0-9]{64}$/);
    assert.match(image.capturedAt, /^\d{4}-\d{2}-\d{2}T/);

    const bytes = Buffer.from(image.base64, 'base64');
    assert.equal(bytes.length, image.bytes);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  },
);

test(
  'Windows screenshot can capture the current foreground window rectangle',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const listed = (await executeWindowsWindowCapability(
      'windows.window.list',
      {
        include_hidden: true,
        limit: 500,
      },
    )) as {
      data: {
        foregroundHwnd: string | null;
      };
    };

    if (!listed.data.foregroundHwnd) return;

    let result;
    try {
      result = await captureWindowsScreenshot({
        source: 'window',
        hwnd: listed.data.foregroundHwnd,
        max_width: 800,
        max_height: 600,
        max_bytes: 3_145_728,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'SCREENSHOT_DESKTOP_UNAVAILABLE'
      ) {
        t.skip('Runner has no capturable interactive desktop.');
        return;
      }
      throw error;
    }

    assert.equal(result.data.source, 'window');
    assert.equal(result.data.hwnd, listed.data.foregroundHwnd);
    assert.ok(result.data.captureRect.width > 0);
    assert.ok(result.data.captureRect.height > 0);
    assert.ok(result.data.width <= 800);
    assert.ok(result.data.height <= 600);
  },
);

test(
  'Windows screenshot rejects an invalid HWND before capture',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        captureWindowsScreenshot({
          source: 'window',
          hwnd: '0x0',
        }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WINDOW_NOT_FOUND',
    );
  },
);

test(
  'Windows screenshot validation requires hwnd only for window source',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        captureWindowsScreenshot({
          source: 'window',
        }),
      /hwnd is required/,
    );

    await assert.rejects(
      () =>
        captureWindowsScreenshot({
          source: 'primary_screen',
          hwnd: '0x1234',
        }),
      /hwnd is only valid/,
    );
  },
);

test('Windows screenshot is classified as read-only for provider failover', () => {
  assert.equal(isReadOnlyCapability('windows.screenshot'), true);
});
