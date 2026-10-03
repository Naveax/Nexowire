import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
    'windows.private_pointer.move',
    'windows.private_pointer.click',
    'windows.private_keyboard.type',
    'windows.private_keyboard.hotkey',
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


test(
  'private desktop routes pointer and keyboard messages without switching the visible desktop',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-private-input-'),
    );
    const fixture = path.join(root, 'input-fixture.ps1');
    const privateLog = path.join(root, 'private.log');
    const privateHandleFile = path.join(root, 'private.hwnd');
    const defaultLog = path.join(root, 'default.log');
    const defaultHandleFile = path.join(root, 'default.hwnd');

    const oldRoot = process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    const oldSkip = process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR = root;
    process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT = '1';

    await fs.writeFile(
      fixture,
      [
        "param([string]$Log,[string]$HandleFile)",
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$source=@'",
        "using System;",
        "using System.IO;",
        "using System.Windows.Forms;",
        "public sealed class NxPrivateInputFixture : Form {",
        "  private readonly string logPath;",
        "  private readonly string handlePath;",
        "  public NxPrivateInputFixture(string log, string handle) {",
        "    logPath = log;",
        "    handlePath = handle;",
        "    Text = \"Nexowire Private Input Fixture\";",
        "    Width = 640;",
        "    Height = 360;",
        "    StartPosition = FormStartPosition.CenterScreen;",
        "    Shown += delegate {",
        "      File.WriteAllText(handlePath, \"0x\" + Handle.ToInt64().ToString(\"X\"));",
        "    };",
        "  }",
        "  protected override void WndProc(ref Message m) {",
        "    if (m.Msg == 0x0200 || m.Msg == 0x0201 || m.Msg == 0x0202 ||",
        "        m.Msg == 0x0100 || m.Msg == 0x0101 || m.Msg == 0x0102) {",
        "      long raw = m.LParam.ToInt64();",
        "      int x = (short)(raw & 0xffff);",
        "      int y = (short)((raw >> 16) & 0xffff);",
        "      File.AppendAllText(",
        "        logPath,",
        "        m.Msg.ToString(\"X4\") + \" : \" + m.WParam.ToInt64() + \" : \" + x + \" : \" + y + Environment.NewLine",
        "      );",
        "    }",
        "    base.WndProc(ref m);",
        "  }",
        "}",
        "'@",
        "Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.Windows.Forms.dll','System.Drawing.dll')",
        "[System.Windows.Forms.Application]::EnableVisualStyles()",
        "$form=[NxPrivateInputFixture]::new($Log,$HandleFile)",
        "[System.Windows.Forms.Application]::Run($form)",
      ].join('\n'),
      'utf8',
    );

    let defaultProcess:
      | ReturnType<typeof spawn>
      | undefined;

    const waitText = async (
      file: string,
      timeoutMs = 8_000,
    ): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const value = (
            await fs.readFile(file, 'utf8')
          ).trim();
          if (value) return value;
        } catch {
          // Keep polling until the fixture is ready.
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 100),
        );
      }
      throw new Error(
        'Timed out waiting for fixture file: ' + file,
      );
    };

    t.after(async () => {
      if (
        defaultProcess &&
        defaultProcess.exitCode === null
      ) {
        try {
          defaultProcess.kill();
        } catch {
          // Best effort cleanup.
        }
      }

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
          await fs.rm(root, {
            recursive: true,
            force: true,
          });
          break;
        } catch {
          await new Promise((resolve) =>
            setTimeout(resolve, 100),
          );
        }
      }
    });

    await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.start',
      { create_shortcut: false },
    );

    await executeWindowsPrivateDesktopCapability(
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
          '-Log',
          privateLog,
          '-HandleFile',
          privateHandleFile,
        ],
      },
    );

    const privateHwnd = await waitText(
      privateHandleFile,
    );
    assert.match(
      privateHwnd,
      /^0x[0-9A-F]+$/i,
    );

    defaultProcess = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-STA',
        '-File',
        fixture,
        '-Log',
        defaultLog,
        '-HandleFile',
        defaultHandleFile,
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    );

    const defaultHwnd = await waitText(
      defaultHandleFile,
    );
    assert.match(
      defaultHwnd,
      /^0x[0-9A-F]+$/i,
    );

    const move = (await executeWindowsPrivateDesktopCapability(
      'windows.private_pointer.move',
      {
        hwnd: privateHwnd,
        x: 40,
        y: 50,
      },
    )) as {
      data: {
        inputDesktop: string;
        touchesSystemCursor: boolean;
        visibleDesktopChanged: boolean;
      };
    };
    assert.equal(move.data.inputDesktop, 'Default');
    assert.equal(move.data.touchesSystemCursor, false);
    assert.equal(move.data.visibleDesktopChanged, false);

    const click = (await executeWindowsPrivateDesktopCapability(
      'windows.private_pointer.click',
      {
        hwnd: privateHwnd,
        x: 45,
        y: 55,
        button: 'left',
        clicks: 1,
      },
    )) as {
      data: {
        inputDesktop: string;
        touchesSystemCursor: boolean;
      };
    };
    assert.equal(click.data.inputDesktop, 'Default');
    assert.equal(click.data.touchesSystemCursor, false);

    const typed = (await executeWindowsPrivateDesktopCapability(
      'windows.private_keyboard.type',
      {
        hwnd: privateHwnd,
        text: 'Hi',
      },
    )) as {
      data: {
        inputDesktop: string;
        charsSent: number;
        touchesSystemKeyboard: boolean;
      };
    };
    assert.equal(typed.data.inputDesktop, 'Default');
    assert.equal(typed.data.charsSent, 2);
    assert.equal(
      typed.data.touchesSystemKeyboard,
      false,
    );

    const hotkey = (await executeWindowsPrivateDesktopCapability(
      'windows.private_keyboard.hotkey',
      {
        hwnd: privateHwnd,
        keys: ['CTRL', 'A'],
      },
    )) as {
      data: {
        inputDesktop: string;
        keyCount: number;
        touchesSystemKeyboard: boolean;
      };
    };
    assert.equal(hotkey.data.inputDesktop, 'Default');
    assert.equal(hotkey.data.keyCount, 2);
    assert.equal(
      hotkey.data.touchesSystemKeyboard,
      false,
    );

    const deadline = Date.now() + 5_000;
    let log = '';
    while (Date.now() < deadline) {
      try {
        log = await fs.readFile(privateLog, 'utf8');
      } catch {
        log = '';
      }
      if (
        log.includes('0200 : 0 : 40 : 50') &&
        log.includes('0201 : 1 : 45 : 55') &&
        log.includes('0202 : 0 : 45 : 55') &&
        log.includes('0102 : 72 : 0 : 0') &&
        log.includes('0102 : 105 : 0 : 0') &&
        log.includes('0100 : 17 : 0 : 0') &&
        log.includes('0100 : 65 : 0 : 0') &&
        log.includes('0101 : 65 : 0 : 0') &&
        log.includes('0101 : 17 : 0 : 0')
      ) {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 100),
      );
    }

    assert.match(log, /0200 : 0 : 40 : 50/);
    assert.match(log, /0201 : 1 : 45 : 55/);
    assert.match(log, /0202 : 0 : 45 : 55/);
    assert.match(log, /0102 : 72 : 0 : 0/);
    assert.match(log, /0102 : 105 : 0 : 0/);
    assert.match(log, /0100 : 17 : 0 : 0/);
    assert.match(log, /0100 : 65 : 0 : 0/);
    assert.match(log, /0101 : 65 : 0 : 0/);
    assert.match(log, /0101 : 17 : 0 : 0/);

    await assert.rejects(
      executeWindowsPrivateDesktopCapability(
        'windows.private_pointer.click',
        {
          hwnd: defaultHwnd,
          x: 20,
          y: 20,
          button: 'left',
        },
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code ===
          'WINDOW_NOT_PRIVATE_DESKTOP',
    );

    const status = (await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.status',
      {},
    )) as {
      data: {
        running: boolean;
        inputDesktop: string;
        visibleDesktopChanged: boolean;
      };
    };
    assert.equal(status.data.running, true);
    assert.equal(status.data.inputDesktop, 'Default');
    assert.equal(
      status.data.visibleDesktopChanged,
      false,
    );
  },
);
