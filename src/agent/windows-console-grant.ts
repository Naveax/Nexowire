import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod';

const GrantRequestSchema = z.object({
  duration_minutes: z.number().int().min(1).max(60).default(5),
  reason: z.string().trim().min(1).max(256).optional(),
});

interface PhysicalConsoleGrant {
  id: string;
  grantedAtMs: number;
  expiresAtMs: number;
  durationMinutes: number;
}

export interface PhysicalConsoleGrantStatus {
  active: boolean;
  grantId: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  remainingMs: number;
  durationMinutes: number | null;
}

export type ConsoleGrantDecisionProvider = (input: {
  durationMinutes: number;
  reason: string | null;
  timeoutMs: number;
}) => Promise<boolean>;

export interface ConsoleGrantRequestOptions {
  now?: () => Date;
  decisionProvider?: ConsoleGrantDecisionProvider;
  timeoutMs?: number;
}

class WindowsConsoleGrantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WindowsConsoleGrantError';
  }
}

const PHYSICAL_CONSOLE_CAPABILITIES = new Set<string>([
  'windows.window.focus',
  'windows.clipboard.write',
  'windows.clipboard.clear',
  'windows.keyboard.type',
  'windows.keyboard.hotkey',
  'windows.pointer.move',
  'windows.pointer.click',
  'windows.pointer.scroll',
  'windows.accessibility.invoke',
  'windows.accessibility.set_value',
  'windows.private_desktop.show',
  'windows.private_viewer.start',
]);

let activeGrant: PhysicalConsoleGrant | null = null;
let promptInFlight = false;
let lastPromptAtMs = 0;

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowsConsoleGrantError(
      'WINDOWS_REQUIRED',
      'Physical console approval requires Windows.',
    );
  }
}

function pruneExpired(nowMs: number): void {
  if (activeGrant && activeGrant.expiresAtMs <= nowMs) {
    activeGrant = null;
  }
}

export function requiresPhysicalConsoleGrant(
  capability: string,
): boolean {
  return PHYSICAL_CONSOLE_CAPABILITIES.has(capability);
}

export function needsPhysicalConsoleApproval(
  capability: string,
  accessMode: 'safe' | 'full' = 'safe',
): boolean {
  return (
    accessMode !== 'full' &&
    requiresPhysicalConsoleGrant(capability)
  );
}

export function physicalConsoleGrantStatus(
  now: Date = new Date(),
): PhysicalConsoleGrantStatus {
  const nowMs = now.getTime();
  pruneExpired(nowMs);
  if (!activeGrant) {
    return {
      active: false,
      grantId: null,
      grantedAt: null,
      expiresAt: null,
      remainingMs: 0,
      durationMinutes: null,
    };
  }
  return {
    active: true,
    grantId: activeGrant.id,
    grantedAt: new Date(activeGrant.grantedAtMs).toISOString(),
    expiresAt: new Date(activeGrant.expiresAtMs).toISOString(),
    remainingMs: Math.max(0, activeGrant.expiresAtMs - nowMs),
    durationMinutes: activeGrant.durationMinutes,
  };
}

export function assertPhysicalConsoleGrant(
  capability: string,
  now: Date = new Date(),
): void {
  if (!requiresPhysicalConsoleGrant(capability)) return;
  if (!physicalConsoleGrantStatus(now).active) {
    throw new WindowsConsoleGrantError(
      'PHYSICAL_CONSOLE_GRANT_REQUIRED',
      'Physical console control is default-denied until the local user explicitly approves a time-bounded grant.',
      { capability },
    );
  }
}

export function revokePhysicalConsoleGrant(): {
  revoked: boolean;
  status: PhysicalConsoleGrantStatus;
} {
  const revoked = activeGrant !== null;
  activeGrant = null;
  return {
    revoked,
    status: physicalConsoleGrantStatus(),
  };
}

const promptScript = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json
$nl=[Environment]::NewLine

$form=New-Object System.Windows.Forms.Form
$form.Text='Nexowire Console Control'
$form.Width=560
$form.Height=330
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$form.ShowInTaskbar=$true
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$form.MinimizeBox=$false

$title=New-Object System.Windows.Forms.Label
$title.Text='Physical console control request'
$title.Font=New-Object System.Drawing.Font('Segoe UI',16,[System.Drawing.FontStyle]::Bold)
$title.AutoSize=$true
$title.Left=24
$title.Top=22
$form.Controls.Add($title)

$message=New-Object System.Windows.Forms.Label
$reason=if([string]::IsNullOrWhiteSpace([string]$inputData.reason)){'No reason supplied.'}else{[string]$inputData.reason}
$message.Text=(
  ('Nexowire requests permission for {0} minute(s).' -f [int]$inputData.durationMinutes) +
  $nl + $nl +
  'While active, remote actions may move/click the physical mouse, type into the foreground window, focus windows, or switch to the Nexowire private desktop.' +
  $nl + $nl + 'Reason: ' + $reason +
  $nl + $nl + 'Choose DENY unless you want this right now.'
)
$message.Font=New-Object System.Drawing.Font('Segoe UI',10)
$message.Left=26
$message.Top=70
$message.Width=500
$message.Height=150
$form.Controls.Add($message)

$deny=New-Object System.Windows.Forms.Button
$deny.Text='DENY'
$deny.Width=120
$deny.Height=42
$deny.Left=270
$deny.Top=235
$deny.DialogResult=[System.Windows.Forms.DialogResult]::No
$form.Controls.Add($deny)

$allow=New-Object System.Windows.Forms.Button
$allow.Text='ALLOW'
$allow.Width=120
$allow.Height=42
$allow.Left=405
$allow.Top=235
$allow.DialogResult=[System.Windows.Forms.DialogResult]::Yes
$form.Controls.Add($allow)

$form.CancelButton=$deny
$form.Add_Shown({$deny.Focus()})
$result=$form.ShowDialog()

[pscustomobject]@{
  approved=($result -eq [System.Windows.Forms.DialogResult]::Yes)
}|ConvertTo-Json -Compress
`;

async function realDecisionProvider(input: {
  durationMinutes: number;
  reason: string | null;
  timeoutMs: number;
}): Promise<boolean> {
  assertWindows();
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        promptScript,
      ],
      {
        windowsHide: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort timeout cleanup.
      }
      finish(() => resolve(false));
    }, input.timeoutMs);

    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(
            new WindowsConsoleGrantError(
              'CONSOLE_GRANT_PROMPT_FAILED',
              Buffer.concat(stderr).toString('utf8').trim() ||
                'Console-control approval prompt failed.',
              { exitCode: code },
            ),
          );
          return;
        }
        try {
          const value = JSON.parse(
            Buffer.concat(stdout)
              .toString('utf8')
              .replace(/^\uFEFF/, '')
              .trim(),
          ) as { approved?: unknown };
          resolve(value.approved === true);
        } catch {
          reject(
            new WindowsConsoleGrantError(
              'CONSOLE_GRANT_PROMPT_OUTPUT_INVALID',
              'Console-control approval prompt returned invalid output.',
            ),
          );
        }
      });
    });

    child.stdin.end(
      JSON.stringify({
        durationMinutes: input.durationMinutes,
        reason: input.reason,
      }),
    );
  });
}

export async function requestPhysicalConsoleGrant(
  input: unknown,
  options: ConsoleGrantRequestOptions = {},
): Promise<{
  approved: boolean;
  status: PhysicalConsoleGrantStatus;
}> {
  assertWindows();
  const parsed = GrantRequestSchema.parse(input);
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  pruneExpired(nowMs);

  if (promptInFlight) {
    throw new WindowsConsoleGrantError(
      'CONSOLE_GRANT_PROMPT_ACTIVE',
      'A physical-console approval prompt is already active.',
    );
  }
  if (nowMs - lastPromptAtMs < 5_000) {
    throw new WindowsConsoleGrantError(
      'CONSOLE_GRANT_PROMPT_COOLDOWN',
      'Wait a few seconds before requesting another physical-console approval.',
    );
  }

  promptInFlight = true;
  lastPromptAtMs = nowMs;
  try {
    const approved = await (
      options.decisionProvider ?? realDecisionProvider
    )({
      durationMinutes: parsed.duration_minutes,
      reason: parsed.reason ?? null,
      timeoutMs: options.timeoutMs ?? 120_000,
    });

    if (!approved) {
      activeGrant = null;
      return {
        approved: false,
        status: physicalConsoleGrantStatus(now()),
      };
    }

    const grantedAtMs = now().getTime();
    activeGrant = {
      id: randomUUID(),
      grantedAtMs,
      expiresAtMs:
        grantedAtMs + parsed.duration_minutes * 60_000,
      durationMinutes: parsed.duration_minutes,
    };

    return {
      approved: true,
      status: physicalConsoleGrantStatus(
        new Date(grantedAtMs),
      ),
    };
  } finally {
    promptInFlight = false;
  }
}

export async function executeWindowsConsoleControlCapability(
  capability: string,
  input: unknown,
): Promise<{ data: unknown }> {
  switch (capability) {
    case 'windows.console_control.status':
      return { data: physicalConsoleGrantStatus() };
    case 'windows.console_control.request':
      return {
        data: await requestPhysicalConsoleGrant(input),
      };
    case 'windows.console_control.revoke':
      return { data: revokePhysicalConsoleGrant() };
    default:
      throw new WindowsConsoleGrantError(
        'UNSUPPORTED',
        'Unsupported console-control capability: ' + capability,
      );
  }
}
