import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod';

const WindowHandleSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);

const ClipboardReadInputSchema = z.object({
  max_chars: z.number().int().min(1).max(100_000).default(20_000),
});

const ClipboardWriteInputSchema = z.object({
  text: z.string().min(1).max(100_000),
});

const KeyboardTypeInputSchema = z.object({
  hwnd: WindowHandleSchema,
  text: z.string().min(1).max(20_000),
  interval_ms: z.number().int().min(0).max(100).default(0),
});

const HotkeyNameSchema = z
  .string()
  .min(1)
  .max(32)
  .transform((value) => value.trim().toUpperCase());

const KeyboardHotkeyInputSchema = z.object({
  hwnd: WindowHandleSchema,
  keys: z.array(HotkeyNameSchema).min(1).max(8),
});

class WindowsInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WindowsInputError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowsInputError(
      'WINDOWS_REQUIRED',
      'Windows input control requires a Windows native agent.',
    );
  }
}

const clipboardPrelude = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Windows.Forms

function Invoke-NexowireClipboard {
  param([scriptblock]$Action)
  $last = $null
  for ($i = 0; $i -lt 8; $i++) {
    try {
      return & $Action
    } catch {
      $last = $_
      Start-Sleep -Milliseconds 60
    }
  }
  if ($null -ne $last) {
    throw $last
  }
}
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
`;

const clipboardReadScript =
  clipboardPrelude +
  String.raw`
try {
  $available = Invoke-NexowireClipboard {
    [System.Windows.Forms.Clipboard]::ContainsText(
      [System.Windows.Forms.TextDataFormat]::UnicodeText
    )
  }
  $text = if ($available) {
    Invoke-NexowireClipboard {
      [System.Windows.Forms.Clipboard]::GetText(
        [System.Windows.Forms.TextDataFormat]::UnicodeText
      )
    }
  } else {
    ''
  }

  $maxChars = [int]$inputData.max_chars
  $truncated = $text.Length -gt $maxChars
  $preview = if ($truncated) {
    $text.Substring(0, $maxChars)
  } else {
    $text
  }

  [pscustomobject]@{
    ok = $true
    textAvailable = [bool]$available
    chars = $text.Length
    truncated = $truncated
    text = $preview
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'CLIPBOARD_UNAVAILABLE'
    message = 'The agent session cannot access the Windows clipboard.'
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 8
}
`;

const clipboardWriteScript =
  clipboardPrelude +
  String.raw`
try {
  $text = [string]$inputData.text
  [void](Invoke-NexowireClipboard {
    [System.Windows.Forms.Clipboard]::SetText(
      $text,
      [System.Windows.Forms.TextDataFormat]::UnicodeText
    )
  })
  $actual = Invoke-NexowireClipboard {
    [System.Windows.Forms.Clipboard]::GetText(
      [System.Windows.Forms.TextDataFormat]::UnicodeText
    )
  }
  if ($actual -cne $text) {
    throw 'Clipboard write verification failed.'
  }

  [pscustomobject]@{
    ok = $true
    chars = $text.Length
    verified = $true
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'CLIPBOARD_UNAVAILABLE'
    message = 'The agent session cannot write and verify the Windows clipboard.'
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 8
}
`;

const clipboardClearScript =
  clipboardPrelude +
  String.raw`
try {
  [void](Invoke-NexowireClipboard {
    [System.Windows.Forms.Clipboard]::Clear()
  })
  $textAvailable = Invoke-NexowireClipboard {
    [System.Windows.Forms.Clipboard]::ContainsText(
      [System.Windows.Forms.TextDataFormat]::UnicodeText
    )
  }

  [pscustomobject]@{
    ok = (-not $textAvailable)
    textAvailable = [bool]$textAvailable
    verified = (-not $textAvailable)
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'CLIPBOARD_UNAVAILABLE'
    message = 'The agent session cannot clear and verify the Windows clipboard.'
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 8
}
`;

const inputPrelude = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if (-not ('NexowireInputNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class NexowireInputNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(
    uint nInputs,
    INPUT[] pInputs,
    int cbSize
  );

  private static void SendOne(ushort vk, ushort scan, uint flags) {
    var input = new INPUT {
      type = INPUT_KEYBOARD,
      U = new InputUnion {
        ki = new KEYBDINPUT {
          wVk = vk,
          wScan = scan,
          dwFlags = flags,
          time = 0,
          dwExtraInfo = UIntPtr.Zero
        }
      }
    };
    var sent = SendInput(1, new [] { input }, Marshal.SizeOf(typeof(INPUT)));
    if (sent != 1) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput failed.");
    }
  }

  public static void SendUnicodeText(string text, int intervalMs) {
    foreach (char ch in text) {
      SendOne(0, ch, KEYEVENTF_UNICODE);
      SendOne(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
      if (intervalMs > 0) Thread.Sleep(intervalMs);
    }
  }

  public static void SendChord(ushort[] keys) {
    foreach (var key in keys) {
      SendOne(key, 0, 0);
    }
    for (int i = keys.Length - 1; i >= 0; i--) {
      SendOne(keys[i], 0, KEYEVENTF_KEYUP);
    }
  }
}
"@
}

$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$raw = [string]$inputData.hwnd
$value = if (
  $raw.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)
) {
  [Convert]::ToInt64($raw.Substring(2), 16)
} else {
  [Convert]::ToInt64($raw, 10)
}
$hWnd = [IntPtr]::new($value)

if (-not [NexowireInputNative]::IsWindow($hWnd)) {
  [pscustomobject]@{
    ok = $false
    code = 'WINDOW_NOT_FOUND'
    message = 'The requested HWND does not identify a current window.'
    hwnd = $raw
  } | ConvertTo-Json -Compress
  exit 3
}

$foreground = [NexowireInputNative]::GetForegroundWindow()
if ($foreground -ne $hWnd) {
  [pscustomobject]@{
    ok = $false
    code = 'WINDOW_NOT_FOREGROUND'
    message = 'Keyboard input is refused because the requested HWND is not the current foreground window.'
    hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
    foregroundHwnd = if ($foreground -eq [IntPtr]::Zero) {
      $null
    } else {
      ('0x{0:X}' -f $foreground.ToInt64())
    }
  } | ConvertTo-Json -Compress
  exit 9
}
`;

const keyboardTypeScript =
  inputPrelude +
  String.raw`
try {
  $text = [string]$inputData.text
  $interval = [int]$inputData.interval_ms
  [NexowireInputNative]::SendUnicodeText($text, $interval)

  $after = [NexowireInputNative]::GetForegroundWindow()
  [pscustomobject]@{
    ok = ($after -eq $hWnd)
    hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
    charsSent = $text.Length
    intervalMs = $interval
    foregroundVerified = ($after -eq $hWnd)
    foregroundHwnd = if ($after -eq [IntPtr]::Zero) {
      $null
    } else {
      ('0x{0:X}' -f $after.ToInt64())
    }
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'KEYBOARD_INPUT_FAILED'
    message = 'Windows keyboard text injection failed.'
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 10
}
`;

const keyboardHotkeyScript =
  inputPrelude +
  String.raw`
try {
  [UInt16[]]$virtualKeys = @($inputData.virtual_keys | ForEach-Object {
    [UInt16]$_
  })
  [NexowireInputNative]::SendChord($virtualKeys)

  $after = [NexowireInputNative]::GetForegroundWindow()
  [pscustomobject]@{
    ok = ($after -eq $hWnd)
    hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
    keysSent = @($inputData.keys)
    foregroundVerified = ($after -eq $hWnd)
    foregroundHwnd = if ($after -eq [IntPtr]::Zero) {
      $null
    } else {
      ('0x{0:X}' -f $after.ToInt64())
    }
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'KEYBOARD_INPUT_FAILED'
    message = 'Windows keyboard hotkey injection failed.'
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 10
}
`;

async function runPowerShellJson<T>(
  script: string,
  input: unknown,
  options: { timeoutMs?: number; sta?: boolean } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return await new Promise<T>((resolve, reject) => {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      ...(options.sta ? ['-STA'] : []),
      '-Command',
      script,
    ];
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
          new WindowsInputError(
            'WINDOWS_INPUT_TIMEOUT',
            'Windows input operation timed out after ' + timeoutMs + 'ms.',
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
            reject(new WindowsInputError(code, message, details));
            return;
          }
        } catch {
          // Fall through to the generic PowerShell error.
        }

        reject(
          new WindowsInputError(
            'WINDOWS_INPUT_FAILED',
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
          new WindowsInputError(
            'WINDOWS_INPUT_INVALID_RESPONSE',
            'Windows input operation returned invalid JSON.',
            { stdout: out.slice(0, 1000) },
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify(input), 'utf8');
  });
}

const NAMED_VIRTUAL_KEYS: Record<string, number> = {
  CTRL: 0x11,
  CONTROL: 0x11,
  SHIFT: 0x10,
  ALT: 0x12,
  WIN: 0x5b,
  WINDOWS: 0x5b,
  ENTER: 0x0d,
  TAB: 0x09,
  ESC: 0x1b,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  BACKSPACE: 0x08,
  DELETE: 0x2e,
  INSERT: 0x2d,
  HOME: 0x24,
  END: 0x23,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
};

function virtualKey(name: string): number {
  if (/^[A-Z]$/.test(name)) return name.charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);

  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(name);
  if (functionKey) {
    return 0x6f + Number(functionKey[1]);
  }

  const named = NAMED_VIRTUAL_KEYS[name];
  if (named !== undefined) return named;

  throw new WindowsInputError(
    'UNSUPPORTED_HOTKEY',
    'Unsupported hotkey key name: ' + name,
    {
      key: name,
      supportedNamedKeys: Object.keys(NAMED_VIRTUAL_KEYS),
      supportedRanges: ['A-Z', '0-9', 'F1-F24'],
    },
  );
}

async function clipboardRead(input: unknown) {
  assertWindows();
  const parsed = ClipboardReadInputSchema.parse(input);
  const data = await runPowerShellJson<{
    textAvailable: boolean;
    chars: number;
    truncated: boolean;
    text: string;
  }>(clipboardReadScript, parsed, { sta: true });

  return {
    data: {
      ...data,
      sha256: createHash('sha256')
        .update(data.text, 'utf8')
        .digest('hex'),
      hashScope: data.truncated ? 'returned-prefix' : 'full-text',
    },
  };
}

async function clipboardWrite(input: unknown) {
  assertWindows();
  const parsed = ClipboardWriteInputSchema.parse(input);
  const data = await runPowerShellJson<{
    chars: number;
    verified: boolean;
  }>(clipboardWriteScript, parsed, { sta: true });
  return {
    data: {
      ...data,
      sha256: createHash('sha256')
        .update(parsed.text, 'utf8')
        .digest('hex'),
    },
  };
}

async function clipboardClear() {
  assertWindows();
  return {
    data: await runPowerShellJson<Record<string, unknown>>(
      clipboardClearScript,
      {},
      { sta: true },
    ),
  };
}

async function keyboardType(input: unknown) {
  assertWindows();
  const parsed = KeyboardTypeInputSchema.parse(input);
  const data = await runPowerShellJson<Record<string, unknown>>(
    keyboardTypeScript,
    parsed,
  );
  return {
    data: {
      ...data,
      sha256: createHash('sha256')
        .update(parsed.text, 'utf8')
        .digest('hex'),
    },
  };
}

async function keyboardHotkey(input: unknown) {
  assertWindows();
  const parsed = KeyboardHotkeyInputSchema.parse(input);
  const unique = new Set(parsed.keys);
  if (unique.size !== parsed.keys.length) {
    throw new WindowsInputError(
      'DUPLICATE_HOTKEY_KEY',
      'Hotkey keys must not contain duplicates.',
      { keys: parsed.keys },
    );
  }

  const virtualKeys = parsed.keys.map(virtualKey);
  return {
    data: await runPowerShellJson<Record<string, unknown>>(
      keyboardHotkeyScript,
      {
        hwnd: parsed.hwnd,
        keys: parsed.keys,
        virtual_keys: virtualKeys,
      },
    ),
  };
}

export async function executeWindowsInputCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.clipboard.read':
      return await clipboardRead(input);
    case 'windows.clipboard.write':
      return await clipboardWrite(input);
    case 'windows.clipboard.clear':
      return await clipboardClear();
    case 'windows.keyboard.type':
      return await keyboardType(input);
    case 'windows.keyboard.hotkey':
      return await keyboardHotkey(input);
    default:
      throw new WindowsInputError(
        'WINDOWS_INPUT_UNSUPPORTED',
        'Unsupported Windows input capability: ' + capability,
      );
  }
}
