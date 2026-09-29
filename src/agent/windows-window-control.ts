import { spawn } from 'node:child_process';
import * as z from 'zod';

const WindowListInputSchema = z.object({
  include_hidden: z.boolean().default(false),
  title_contains: z.string().max(1024).optional(),
  process_id: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(2000).default(200),
});

const WindowHandleSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);

const WindowFocusInputSchema = z.object({
  hwnd: WindowHandleSchema,
  restore_if_minimized: z.boolean().default(true),
});

class WindowControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WindowControlError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowControlError(
      'WINDOWS_REQUIRED',
      'Window control requires a Windows native agent.',
    );
  }
}

const nativePrelude = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
if (-not ('NexowireWindowNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NexowireWindowNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetWindowText(
    IntPtr hWnd,
    StringBuilder lpString,
    int nMaxCount
  );

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(
    IntPtr hWnd,
    out uint lpdwProcessId
  );

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetActiveWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetFocus(IntPtr hWnd);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool AttachThreadInput(
    uint idAttach,
    uint idAttachTo,
    [MarshalAs(UnmanagedType.Bool)] bool fAttach
  );

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
}
`;

const listScript =
  nativePrelude +
  String.raw`
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$includeHidden = [bool]$inputData.include_hidden
$titleContains = if ($null -ne $inputData.title_contains) {
  [string]$inputData.title_contains
} else {
  $null
}
$processIdFilter = if ($null -ne $inputData.process_id) {
  [int]$inputData.process_id
} else {
  $null
}
$limit = [int]$inputData.limit
$foreground = [NexowireWindowNative]::GetForegroundWindow()
$items = New-Object System.Collections.Generic.List[object]

$callback = [NexowireWindowNative+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)

  if ($items.Count -ge $limit) {
    return $false
  }

  $visible = [NexowireWindowNative]::IsWindowVisible($hWnd)
  if (-not $includeHidden -and -not $visible) {
    return $true
  }

  $length = [NexowireWindowNative]::GetWindowTextLength($hWnd)
  $builder = New-Object System.Text.StringBuilder ([Math]::Max(1, $length + 1))
  [void][NexowireWindowNative]::GetWindowText(
    $hWnd,
    $builder,
    $builder.Capacity
  )
  $title = $builder.ToString()

  if (
    $null -ne $titleContains -and
    $title.IndexOf(
      $titleContains,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -lt 0
  ) {
    return $true
  }

  [uint32]$pidValue = 0
  [void][NexowireWindowNative]::GetWindowThreadProcessId(
    $hWnd,
    [ref]$pidValue
  )
  if (
    $null -ne $processIdFilter -and
    [int]$pidValue -ne $processIdFilter
  ) {
    return $true
  }

  $rect = New-Object NexowireWindowNative+RECT
  $hasRect = [NexowireWindowNative]::GetWindowRect($hWnd, [ref]$rect)
  $processName = $null
  try {
    $processName = (Get-Process -Id ([int]$pidValue) -ErrorAction Stop).ProcessName
  } catch {
    $processName = $null
  }

  $items.Add([pscustomobject]@{
    hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
    title = $title
    processId = [int]$pidValue
    processName = $processName
    visible = $visible
    minimized = [NexowireWindowNative]::IsIconic($hWnd)
    foreground = ($hWnd -eq $foreground)
    rect = if ($hasRect) {
      [pscustomobject]@{
        left = $rect.Left
        top = $rect.Top
        right = $rect.Right
        bottom = $rect.Bottom
        width = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
      }
    } else {
      $null
    }
  })

  return $true
}

[void][NexowireWindowNative]::EnumWindows($callback, [IntPtr]::Zero)
[pscustomobject]@{
  windows = $items.ToArray()
  truncated = ($items.Count -ge $limit)
  foregroundHwnd = if ($foreground -eq [IntPtr]::Zero) {
    $null
  } else {
    ('0x{0:X}' -f $foreground.ToInt64())
  }
} | ConvertTo-Json -Depth 8 -Compress
`;

const focusScript =
  nativePrelude +
  String.raw`
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$raw = [string]$inputData.hwnd
$value = if ($raw.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)) {
  [Convert]::ToInt64($raw.Substring(2), 16)
} else {
  [Convert]::ToInt64($raw, 10)
}
$hWnd = [IntPtr]::new($value)

if (-not [NexowireWindowNative]::IsWindow($hWnd)) {
  [pscustomobject]@{
    ok = $false
    code = 'WINDOW_NOT_FOUND'
    message = 'The requested HWND does not identify a current top-level window.'
    hwnd = $raw
  } | ConvertTo-Json -Compress
  exit 3
}

$length = [NexowireWindowNative]::GetWindowTextLength($hWnd)
$builder = New-Object System.Text.StringBuilder ([Math]::Max(1, $length + 1))
[void][NexowireWindowNative]::GetWindowText(
  $hWnd,
  $builder,
  $builder.Capacity
)

$wasMinimized = [NexowireWindowNative]::IsIconic($hWnd)
$restoreAttempted = $false
$restoreResult = $false
if ($wasMinimized -and [bool]$inputData.restore_if_minimized) {
  $restoreAttempted = $true
  $restoreResult = [NexowireWindowNative]::ShowWindowAsync($hWnd, 9)
  Start-Sleep -Milliseconds 50
}

$setResult = [NexowireWindowNative]::SetForegroundWindow($hWnd)
Start-Sleep -Milliseconds 75
$foreground = [NexowireWindowNative]::GetForegroundWindow()
$verified = ($foreground -eq $hWnd)
$fallbackAttempted = $false
$bringToTopResult = $false
$attachedForeground = $false
$attachedTarget = $false

if (-not $verified) {
  $fallbackAttempted = $true
  [uint32]$ignoredPid = 0
  $currentThread = [NexowireWindowNative]::GetCurrentThreadId()
  $targetThread = [NexowireWindowNative]::GetWindowThreadProcessId(
    $hWnd,
    [ref]$ignoredPid
  )
  $foregroundThread = 0
  if ($foreground -ne [IntPtr]::Zero) {
    $foregroundThread = [NexowireWindowNative]::GetWindowThreadProcessId(
      $foreground,
      [ref]$ignoredPid
    )
  }

  try {
    if (
      $foregroundThread -ne 0 -and
      $foregroundThread -ne $currentThread
    ) {
      $attachedForeground = [NexowireWindowNative]::AttachThreadInput(
        $currentThread,
        $foregroundThread,
        $true
      )
    }
    if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
      $attachedTarget = [NexowireWindowNative]::AttachThreadInput(
        $currentThread,
        $targetThread,
        $true
      )
    }

    $bringToTopResult = [NexowireWindowNative]::BringWindowToTop($hWnd)
    [void][NexowireWindowNative]::SetActiveWindow($hWnd)
    [void][NexowireWindowNative]::SetFocus($hWnd)
    $setResult = [NexowireWindowNative]::SetForegroundWindow($hWnd)
  } finally {
    if ($attachedTarget) {
      [void][NexowireWindowNative]::AttachThreadInput(
        $currentThread,
        $targetThread,
        $false
      )
    }
    if ($attachedForeground) {
      [void][NexowireWindowNative]::AttachThreadInput(
        $currentThread,
        $foregroundThread,
        $false
      )
    }
  }

  Start-Sleep -Milliseconds 100
  $foreground = [NexowireWindowNative]::GetForegroundWindow()
  $verified = ($foreground -eq $hWnd)
}

[pscustomobject]@{
  ok = $verified
  hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
  title = $builder.ToString()
  wasMinimized = $wasMinimized
  restoreAttempted = $restoreAttempted
  restoreResult = $restoreResult
  setForegroundResult = $setResult
  fallbackAttempted = $fallbackAttempted
  bringToTopResult = $bringToTopResult
  attachedForeground = $attachedForeground
  attachedTarget = $attachedTarget
  verified = $verified
  foregroundHwnd = if ($foreground -eq [IntPtr]::Zero) {
    $null
  } else {
    ('0x{0:X}' -f $foreground.ToInt64())
  }
} | ConvertTo-Json -Depth 5 -Compress
`;

async function runPowerShellJson<T>(
  script: string,
  input: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        env: {
          ...process.env,
          NEXOWIRE_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();

      if (timedOut) {
        reject(
          new WindowControlError(
            'WINDOW_CONTROL_TIMEOUT',
            'Windows window-control operation timed out after ' +
              timeoutMs +
              'ms.',
          ),
        );
        return;
      }

      if (exitCode !== 0) {
        try {
          const parsed = JSON.parse(out) as {
            code?: string;
            message?: string;
            [key: string]: unknown;
          };
          if (parsed.code && parsed.message) {
            const { code, message, ...details } = parsed;
            reject(
              new WindowControlError(
                code,
                message,
                details,
              ),
            );
            return;
          }
        } catch {
          // Fall through to the generic PowerShell error.
        }

        reject(
          new WindowControlError(
            'WINDOW_CONTROL_FAILED',
            err ||
              out ||
              'PowerShell exited with code ' +
                (exitCode ?? 'unknown') +
                '.',
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(
          new WindowControlError(
            'WINDOW_CONTROL_INVALID_RESPONSE',
            'Windows window-control operation returned invalid JSON.',
            { stdout: out.slice(0, 1000) },
          ),
        );
      }
    });
  });
}

async function listWindows(input: unknown) {
  assertWindows();
  const parsed = WindowListInputSchema.parse(input);
  return {
    data: await runPowerShellJson<Record<string, unknown>>(
      listScript,
      parsed,
      30_000,
    ),
  };
}

async function focusWindow(input: unknown) {
  assertWindows();
  const parsed = WindowFocusInputSchema.parse(input);
  const result = await runPowerShellJson<{
    ok: boolean;
    hwnd: string;
    title: string;
    verified: boolean;
    foregroundHwnd: string | null;
    [key: string]: unknown;
  }>(focusScript, parsed, 30_000);

  if (!result.verified) {
    throw new WindowControlError(
      'WINDOW_FOCUS_NOT_VERIFIED',
      'Windows did not grant foreground focus to the requested window.',
      {
        hwnd: result.hwnd,
        title: result.title,
        foregroundHwnd: result.foregroundHwnd,
      },
    );
  }

  return { data: result };
}

export async function executeWindowsWindowCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.window.list':
      return await listWindows(input);
    case 'windows.window.focus':
      return await focusWindow(input);
    default:
      throw new WindowControlError(
        'WINDOW_CONTROL_UNSUPPORTED',
        'Unsupported Windows window capability: ' + capability,
      );
  }
}
