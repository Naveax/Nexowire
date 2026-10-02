import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  executeWindowsPrivateDesktopCapability,
} from '../src/agent/windows-private-desktop.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

test('private desktop status/windows are read-only while lifecycle/launch mutate', () => {
  for (const capability of [
    'windows.private_desktop.status',
    'windows.private_desktop.windows',
  ]) {
    assert.equal(isReadOnlyCapability(capability), true, capability);
  }

  for (const capability of [
    'windows.private_desktop.start',
    'windows.private_desktop.stop',
    'windows.private_desktop.launch',
  ]) {
    assert.equal(isReadOnlyCapability(capability), false, capability);
  }
});

test(
  'private desktop hosts isolated GUI windows without switching the input desktop',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-private-desktop-'),
    );
    const fixture = path.join(root, 'fixture.ps1');

    const oldRoot = process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    const oldSkip = process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR = root;
    process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT = '1';

    await fs.writeFile(
      fixture,
      [
        "$ErrorActionPreference='Stop'",
        'Add-Type -AssemblyName PresentationFramework',
        'Add-Type -AssemblyName PresentationCore',
        'Add-Type -AssemblyName WindowsBase',
        '$w=New-Object Windows.Window',
        "$w.Title='Nexowire Private Fixture'",
        '$w.Width=700',
        '$w.Height=420',
        "$w.WindowStartupLocation='CenterScreen'",
        "$w.Background=[Windows.Media.BrushConverter]::new().ConvertFromString('#20242D')",
        '$t=New-Object Windows.Controls.TextBlock',
        "$t.Text='PRIVATE APP FIXTURE'",
        '$t.FontSize=30',
        "$t.Foreground='White'",
        "$t.HorizontalAlignment='Center'",
        "$t.VerticalAlignment='Center'",
        '$w.Content=$t',
        '[void]$w.ShowDialog()',
      ].join('\n'),
      'utf8',
    );

    t.after(async () => {
      try {
        await executeWindowsPrivateDesktopCapability(
          'windows.private_desktop.stop',
          {},
        );
      } catch {
        // Best effort cleanup.
      }

      if (oldRoot === undefined) {
        delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
      } else {
        process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR = oldRoot;
      }
      if (oldSkip === undefined) {
        delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
      } else {
        process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT = oldSkip;
      }

      for (let i = 0; i < 20; i += 1) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    });

    const before = (await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.status',
      {},
    )) as {
      data: {
        running: boolean;
        inputDesktop: string;
        visibleDesktopChanged: boolean;
      };
    };
    assert.equal(before.data.running, false);
    assert.equal(before.data.visibleDesktopChanged, false);

    const started = (await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.start',
      { create_shortcut: false },
    )) as {
      data: {
        running: boolean;
        desktopName: string;
        hostPid: number;
        shellPid: number;
        inputDesktop: string;
        visibleDesktopChanged: boolean;
        shortcut: string | null;
      };
    };

    assert.equal(started.data.running, true);
    assert.equal(started.data.desktopName, 'NexowirePrivate');
    assert.ok(started.data.hostPid > 0);
    assert.ok(started.data.shellPid > 0);
    assert.equal(started.data.inputDesktop, 'Default');
    assert.equal(started.data.visibleDesktopChanged, false);
    assert.equal(started.data.shortcut, null);

    const shellView = (await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.windows',
      {},
    )) as {
      data: {
        inputDesktop: string;
        visibleDesktopChanged: boolean;
        windows: Array<{
          title: string;
          processId: number;
          visible: boolean;
          rect: { width: number; height: number };
        }>;
      };
    };

    assert.equal(shellView.data.inputDesktop, 'Default');
    assert.equal(shellView.data.visibleDesktopChanged, false);
    const shell = shellView.data.windows.find(
      (window) => window.title === 'Nexowire Private Desktop',
    );
    assert.ok(shell);
    assert.equal(shell.visible, true);
    assert.equal(shell.processId, started.data.shellPid);
    assert.ok(shell.rect.width > 0);
    assert.ok(shell.rect.height > 0);

    const launched = (await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.launch',
      {
        executable: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-STA',
          '-File',
          fixture,
        ],
      },
    )) as {
      data: {
        pid: number;
        desktopName: string;
        visibleDesktopChanged: boolean;
      };
    };

    assert.ok(launched.data.pid > 0);
    assert.equal(launched.data.desktopName, 'NexowirePrivate');
    assert.equal(launched.data.visibleDesktopChanged, false);

    let fixtureWindow:
      | {
          title: string;
          processId: number;
          visible: boolean;
          rect: { width: number; height: number };
        }
      | undefined;

    for (let i = 0; i < 30; i += 1) {
      const view = (await executeWindowsPrivateDesktopCapability(
        'windows.private_desktop.windows',
        {},
      )) as {
        data: {
          inputDesktop: string;
          windows: Array<{
            title: string;
            processId: number;
            visible: boolean;
            rect: { width: number; height: number };
          }>;
        };
      };
      assert.equal(view.data.inputDesktop, 'Default');
      fixtureWindow = view.data.windows.find(
        (window) => window.title === 'Nexowire Private Fixture',
      );
      if (fixtureWindow?.visible) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(fixtureWindow);
    assert.equal(fixtureWindow.visible, true);
    assert.equal(fixtureWindow.processId, launched.data.pid);
    assert.equal(fixtureWindow.rect.width, 700);
    assert.equal(fixtureWindow.rect.height, 420);

    const status = (await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.status',
      {},
    )) as {
      data: {
        running: boolean;
        inputDesktop: string;
        visibleDesktopChanged: boolean;
        launchedPids: number[];
      };
    };

    assert.equal(status.data.running, true);
    assert.equal(status.data.inputDesktop, 'Default');
    assert.equal(status.data.visibleDesktopChanged, false);
    assert.ok(status.data.launchedPids.includes(launched.data.pid));

    const stopped = (await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.stop',
      {},
    )) as {
      data: {
        running: boolean;
        stopped: boolean;
        inputDesktop: string;
      };
    };

    assert.equal(stopped.data.running, false);
    assert.equal(stopped.data.stopped, true);
    assert.equal(stopped.data.inputDesktop, 'Default');
  },
);
