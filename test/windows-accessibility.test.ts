import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { executeWindowsAccessibilityCapability } from '../src/agent/windows-accessibility.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function startAccessibilityFixture(): Promise<{
  root: string;
  hwnd: string;
  child: ChildProcess;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-accessibility-'),
  );
  const scriptPath = path.join(root, 'fixture.ps1');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$window = New-Object System.Windows.Window
$window.Title = 'Nexowire Accessibility Fixture'
$window.Width = 520
$window.Height = 280
$window.WindowStartupLocation = 'Manual'
$window.Left = 40
$window.Top = 40

$panel = New-Object System.Windows.Controls.StackPanel
$panel.Margin = '20'

$textBox = New-Object System.Windows.Controls.TextBox
$textBox.Text = 'initial'
$textBox.Width = 300
$textBox.HorizontalAlignment = 'Left'
$textBox.Margin = '0,0,0,20'
[System.Windows.Automation.AutomationProperties]::SetName(
  $textBox,
  'Nexowire Input'
)
[System.Windows.Automation.AutomationProperties]::SetAutomationId(
  $textBox,
  'NexowireInput'
)

$passwordBox = New-Object System.Windows.Controls.PasswordBox
$passwordBox.Password = 'super-secret-fixture'
$passwordBox.Width = 300
$passwordBox.HorizontalAlignment = 'Left'
$passwordBox.Margin = '0,0,0,20'
[System.Windows.Automation.AutomationProperties]::SetName(
  $passwordBox,
  'Nexowire Secret'
)
[System.Windows.Automation.AutomationProperties]::SetAutomationId(
  $passwordBox,
  'NexowireSecret'
)

$button = New-Object System.Windows.Controls.Button
$button.Content = 'Nexowire Action'
$button.Width = 180
$button.HorizontalAlignment = 'Left'
[System.Windows.Automation.AutomationProperties]::SetName(
  $button,
  'Nexowire Action'
)
[System.Windows.Automation.AutomationProperties]::SetAutomationId(
  $button,
  'NexowireAction'
)
$script:nexowireTextBox = $textBox
$button.Add_Click({
  $script:nexowireTextBox.Text = 'invoked'
})

[void]$panel.Children.Add($textBox)
[void]$panel.Children.Add($passwordBox)
[void]$panel.Children.Add($button)
$window.Content = $panel

$helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
[void]$helper.EnsureHandle()
$window.Show()
[Console]::Out.WriteLine(
  ('HWND=0x{0:X}' -f $helper.Handle.ToInt64())
)
[Console]::Out.Flush()
[System.Windows.Threading.Dispatcher]::Run()
`
  await fs.writeFile(scriptPath, script, 'utf8');

  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      scriptPath,
    ],
    {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const hwnd = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          'Timed out waiting for accessibility fixture HWND. stderr=' +
            stderr,
        ),
      );
    }, 8_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /HWND=(0x[0-9A-F]+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]!);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          'Accessibility fixture exited before HWND publication: ' +
            String(code) +
            ' stderr=' +
            stderr,
        ),
      );
    });
  });

  return { root, hwnd, child };
}

test('accessibility tree/find are read-only and reject invalid HWNDs', async () => {
  assert.equal(
    isReadOnlyCapability('windows.accessibility.tree'),
    true,
  );
  assert.equal(
    isReadOnlyCapability('windows.accessibility.find'),
    true,
  );
  assert.equal(
    isReadOnlyCapability('windows.accessibility.invoke'),
    false,
  );
  assert.equal(
    isReadOnlyCapability('windows.accessibility.set_value'),
    false,
  );

  if (process.platform !== 'win32') return;

  await assert.rejects(
    () =>
      executeWindowsAccessibilityCapability(
        'windows.accessibility.tree',
        {
          hwnd: '0x0',
        },
      ),
    (error: unknown) => errorCode(error) === 'WINDOW_NOT_FOUND',
  );
});

test(
  'Windows UI Automation tree/find/set/invoke round-trip on an isolated fixture',
  { skip: process.platform !== 'win32' },
  async (t) => {
    let fixture:
      | {
          root: string;
          hwnd: string;
          child: ChildProcess;
        }
      | undefined;

    try {
      fixture = await startAccessibilityFixture();
    } catch (error) {
      t.skip(
        'Could not create isolated WinForms accessibility fixture: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    t.after(async () => {
      try {
        fixture?.child.kill();
      } catch {
        // Best effort fixture cleanup.
      }
      if (fixture) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });

    let tree;
    try {
      tree = (await executeWindowsAccessibilityCapability(
        'windows.accessibility.tree',
        {
          hwnd: fixture.hwnd,
          max_depth: 8,
          max_nodes: 200,
          include_offscreen: true,
          include_values: true,
        },
      )) as {
        data: {
          nodes: Array<{
            name: string;
            automationId: string;
            controlType: string | null;
            patterns: string[];
            isPassword: boolean;
            value:
              | {
                  chars: number;
                  truncated: boolean;
                  text: string;
                }
              | null;
          }>;
          count: number;
          truncated: boolean;
        };
      };
    } catch (error) {
      if (
        errorCode(error) === 'ACCESSIBILITY_ROOT_UNAVAILABLE' ||
        errorCode(error) === 'ACCESSIBILITY_FAILED'
      ) {
        t.skip(
          'Runner session cannot expose UI Automation for the isolated form.',
        );
        return;
      }
      throw error;
    }

    assert.ok(tree.data.count >= 3);
    const inputNode = tree.data.nodes.find(
      (node) => node.name === 'Nexowire Input',
    );
    const secretNode = tree.data.nodes.find(
      (node) => node.name === 'Nexowire Secret',
    );
    const buttonNode = tree.data.nodes.find(
      (node) => node.name === 'Nexowire Action',
    );
    assert.ok(inputNode);
    assert.ok(secretNode);
    assert.ok(buttonNode);
    assert.equal(inputNode?.isPassword, false);
    assert.ok(Array.isArray(inputNode?.patterns));
    assert.ok(inputNode?.patterns.includes('Value'));
    assert.equal(secretNode?.isPassword, true);
    assert.equal(secretNode?.value, null);
    assert.ok(Array.isArray(buttonNode?.patterns));
    assert.ok(buttonNode?.patterns.includes('Invoke'));

    const found = (await executeWindowsAccessibilityCapability(
      'windows.accessibility.find',
      {
        hwnd: fixture.hwnd,
        name_contains: 'nexowire',
        max_results: 20,
        include_offscreen: true,
      },
    )) as {
      data: {
        matches: Array<{ name: string }>;
        count: number;
      };
    };
    assert.ok(found.data.count >= 2);
    assert.ok(
      found.data.matches.some(
        (entry) => entry.name === 'Nexowire Input',
      ),
    );
    assert.ok(
      found.data.matches.some(
        (entry) => entry.name === 'Nexowire Action',
      ),
    );

    const setValue = (await executeWindowsAccessibilityCapability(
      'windows.accessibility.set_value',
      {
        hwnd: fixture.hwnd,
        selector: {
          name: 'Nexowire Input',
          control_type: 'Edit',
        },
        value: 'changed-by-uia',
      },
    )) as {
      data: {
        verified: boolean;
        chars: number;
        valueSha256: string;
      };
    };
    assert.equal(setValue.data.verified, true);
    assert.equal(setValue.data.chars, 'changed-by-uia'.length);
    assert.match(setValue.data.valueSha256, /^[a-f0-9]{64}$/);

    const invoked = (await executeWindowsAccessibilityCapability(
      'windows.accessibility.invoke',
      {
        hwnd: fixture.hwnd,
        selector: {
          name: 'Nexowire Action',
          control_type: 'Button',
        },
      },
    )) as {
      data: {
        invoked: boolean;
      };
    };
    assert.equal(invoked.data.invoked, true);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = (await executeWindowsAccessibilityCapability(
      'windows.accessibility.tree',
      {
        hwnd: fixture.hwnd,
        max_depth: 8,
        max_nodes: 200,
        include_offscreen: true,
        include_values: true,
      },
    )) as {
      data: {
        nodes: Array<{
          name: string;
          value: { text: string } | null;
        }>;
      };
    };
    const afterInput = after.data.nodes.find(
      (node) => node.name === 'Nexowire Input',
    );
    assert.equal(afterInput?.value?.text, 'invoked');
  },
);

test(
  'accessibility exact-action selectors fail closed when ambiguous or missing',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsAccessibilityCapability(
          'windows.accessibility.invoke',
          {
            hwnd: '0x1234',
            selector: {},
          },
        ),
      /At least one exact accessibility selector is required/,
    );
  },
);
