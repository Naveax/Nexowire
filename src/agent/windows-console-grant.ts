import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod';
import type {CoreConsoleAdmission} from './core-console-admission.js';
import {windowsDpapiChildEnvironment} from '../security/windows-dpapi.js';

const GrantRequestSchema = z.object({
  mode: z.literal('timed').default('timed'),
  duration_minutes: z.number().int().min(1).max(60).default(5),
  reason: z.string().trim().min(1).max(256).optional(),
}).strict();

interface PhysicalConsoleGrant {
  id: string;
  grantedAtMs: number;
  expiresAtMs: number;
  durationMinutes: number;
  // Rewinding the wall clock must not extend a timed grant.
  monotonicExpiresAtMs: number;
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
  signal: AbortSignal;
}) => Promise<boolean>;

export interface ConsoleGrantRequestOptions {
  now?: () => Date;
  decisionProvider?: ConsoleGrantDecisionProvider;
  timeoutMs?: number;
  signal?: AbortSignal;
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
let grantEpoch = 0;
let pendingPrompt: AbortController | null = null;

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new WindowsConsoleGrantError(
      'WINDOWS_REQUIRED',
      'Physical console approval requires Windows.',
    );
  }
}

function pruneExpired(nowMs: number): void {
  if (activeGrant && (activeGrant.expiresAtMs <= nowMs ||
      performance.now() >= activeGrant.monotonicExpiresAtMs ||
      nowMs < activeGrant.grantedAtMs)) {
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
  _accessMode: 'safe' | 'full' = 'safe',
): boolean {
  // Control-plane Full Access authorizes remote API operations, NOT access
  // to the owner's visible physical desktop. Only a separate, short-lived
  // local-console grant allows foreground/input/clipboard mutations.
  return requiresPhysicalConsoleGrant(capability);
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
    remainingMs: Math.max(0, Math.floor(Math.min(activeGrant.expiresAtMs - nowMs,
      activeGrant.monotonicExpiresAtMs - performance.now()))),
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
  const revoked = activeGrant !== null || pendingPrompt !== null;
  ++grantEpoch;
  activeGrant = null;
  pendingPrompt?.abort();
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
  signal: AbortSignal;
}): Promise<boolean> {
  assertWindows();
  if (input.signal.aborted) return false;
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
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
        shell: false,
        cwd: 'C:\\Windows\\System32',
        env: windowsDpapiChildEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => { /* Prompt may exit while cancelling stdin. */ });

    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', cancel);
      callback();
    };
    const cancel = (): void => {
      try { child.kill(); } catch { /* Already exited. */ }
      finish(() => resolve(false));
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort timeout cleanup.
      }
      finish(() => resolve(false));
    }, input.timeoutMs);
    input.signal.addEventListener('abort', cancel, {once:true});
    if (input.signal.aborted) cancel();

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
  if (typeof input === 'object' && input !== null && 'mode' in input &&
      input.mode === 'core') {
    throw new WindowsConsoleGrantError('CORE_CONSOLE_ENROLLMENT_UNAVAILABLE',
      'A protected local CORE enrollment provider is not installed. No timed fallback or automatic approval was performed.');
  }
  const parsed = GrantRequestSchema.parse(input);
  if (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
    throw new WindowsConsoleGrantError('CONSOLE_GRANT_TIMEOUT_INVALID',
      'Approval timeout must be a positive integer.');
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || options.signal?.aborted)
    throw new WindowsConsoleGrantError('CONSOLE_GRANT_REQUEST_CANCELLED',
      'The console approval request is cancelled or its clock is invalid.');
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
  const epoch = grantEpoch;
  const abort = new AbortController();
  pendingPrompt = abort;
  const cancel = (): void => { revokePhysicalConsoleGrant(); };
  options.signal?.addEventListener('abort', cancel, {once:true});
  const timeoutMs = Math.min(120_000,Math.max(1,options.timeoutMs ?? 120_000));
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<false>(resolve => {
      onAbort = () => resolve(false);
      abort.signal.addEventListener('abort', onAbort, {once:true});
      timer = setTimeout(() => abort.abort(),timeoutMs);
    });
    const approved = await Promise.race([
      cancelled,
      (options.decisionProvider ?? realDecisionProvider)({
        durationMinutes: parsed.duration_minutes,
        reason: parsed.reason ?? null,timeoutMs,signal:abort.signal,
      }),
    ]);

    if (!approved || abort.signal.aborted || epoch !== grantEpoch ||
        options.signal?.aborted) {
      activeGrant = null;
      return {
        approved: false,
        status: physicalConsoleGrantStatus(now()),
      };
    }

    const grantedAtMs = now().getTime();
    if (!Number.isSafeInteger(grantedAtMs) || grantedAtMs < nowMs)
      throw new WindowsConsoleGrantError('CONSOLE_GRANT_CLOCK_INVALID',
        'The clock changed during approval; request new local consent.');
    activeGrant = {
      id: randomUUID(),
      grantedAtMs,
      expiresAtMs:
        grantedAtMs + parsed.duration_minutes * 60_000,
      durationMinutes: parsed.duration_minutes,
      monotonicExpiresAtMs: performance.now() + parsed.duration_minutes * 60_000,
    };

    return {
      approved: true,
      status: physicalConsoleGrantStatus(new Date(grantedAtMs)),
    };
  } finally {
    clearTimeout(timer);
    if (onAbort) abort.signal.removeEventListener('abort',onAbort);
    options.signal?.removeEventListener('abort',cancel);
    if (pendingPrompt === abort) pendingPrompt = null;
    promptInFlight = false;
  }
}

export async function executeWindowsConsoleControlCapability(
  capability: string,
  input: unknown,
  accessMode: 'safe' | 'full' = 'safe',
  coreConsole?: CoreConsoleAdmission,
  signal?: AbortSignal,
): Promise<{ data: unknown }> {
  switch (capability) {
    case 'windows.console_control.status': {
      const timed = physicalConsoleGrantStatus();
      const core = coreConsole ? await coreConsole.status(accessMode) : {
          preferenceEnabled:null,localEnrolled:false,active:false,
          duration:'indefinite-revocable',expiresAt:null,
          state:'CORE_CONSOLE_PROVIDER_UNAVAILABLE',
        };
      return {data:{...timed,active:timed.active || core.active,
        mode:timed.active?'timed':core.active?'core':null,
        remainingMs:timed.active?timed.remainingMs:core.active?null:0,
        core}};
    }
    case 'windows.console_control.request':
      // Even FULL must get a real, time-bounded local physical-console
      // approval. Never synthesize an owner grant from API access alone.
      if(typeof input==='object'&&input!==null&&'mode' in input&&input.mode==='core'){
        z.strictObject({mode:z.literal('core'),reason:z.string().max(256).optional()}).parse(input);
        if(accessMode!=='full')throw new WindowsConsoleGrantError('CORE_REQUIRES_FULL','CORE console requires FULL mode.');
        if(!coreConsole)throw new WindowsConsoleGrantError('CORE_CONSOLE_PROVIDER_UNAVAILABLE','Local CORE provider is unavailable.');
        const approved=await coreConsole.enroll(signal??new AbortController().signal);
        const core=await coreConsole.status(accessMode);
        return {data:{approved:approved&&core.active,localDecisionApproved:approved,
          mode:'core',status:{active:core.active,expiresAt:null,core}}};
      }
      return {
        data: await requestPhysicalConsoleGrant(input, {signal}),
      };
    case 'windows.console_control.revoke': {
      const result = revokePhysicalConsoleGrant();
      await coreConsole?.revoke();
      return { data: {...result,revoked:result.revoked||coreConsole?.installed===true,
        ...(coreConsole?{core:await coreConsole.status(accessMode)}:{})} };
    }
    default:
      throw new WindowsConsoleGrantError(
        'UNSUPPORTED',
        'Unsupported console-control capability: ' + capability,
      );
  }
}
