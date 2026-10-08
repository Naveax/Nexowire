import { spawn } from 'node:child_process';
import type { PrivilegedBrokerClient } from './privileged-broker-client.js';

export type UacObservation = 'pending' | 'clear' | 'unknown';

export interface WindowsUacStatus {
  observation: UacObservation;
  consentProcessCount: number | null;
  currentSessionOnly: boolean;
  accessMode: 'safe' | 'full';
  brokerReachable: boolean;
  brokerElevated: boolean;
  recommendedAction:
    | 'use_preapproved_installer_broker'
    | 'local_user_consent_required'
    | 'investigate_process_visibility'
    | 'no_uac_prompt_detected';
  autoClickConsentSupported: false;
  message: string;
}

export interface WindowsUacStatusOptions {
  platform?: NodeJS.Platform;
  accessMode: 'safe' | 'full';
  broker?: Pick<PrivilegedBrokerClient, 'probe'>;
  consentCount?: () => Promise<number>;
}

async function enumerateConsentProcesses(): Promise<number> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$session=[System.Diagnostics.Process]::GetCurrentProcess().SessionId',
    '$c=@(Get-CimInstance Win32_Process -Filter "Name=\'consent.exe\'" | Where-Object { [int]$_.SessionId -eq $session })',
    '[Console]::Out.Write($c.Count)',
  ].join(';');
  return await new Promise<number>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const limit = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out inspecting UAC consent process.'));
    }, 8_000);
    limit.unref?.();
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', (error) => {
      clearTimeout(limit);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(limit);
      if (code !== 0) {
        reject(new Error(
          Buffer.concat(errors).toString('utf8').trim() ||
          'UAC process inspection returned a non-zero exit code.',
        ));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!/^\d{1,4}$/.test(text)) {
        reject(new Error('Unexpected UAC inspection output.'));
        return;
      }
      resolve(Number(text));
    });
  });
}

export async function inspectWindowsUacStatus(
  options: WindowsUacStatusOptions,
): Promise<WindowsUacStatus> {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new Error('Windows UAC inspection requires a Windows agent.');
  }
  let count: number | null = null;
  try {
    count = await (options.consentCount ?? enumerateConsentProcesses)();
    if (!Number.isInteger(count) || count < 0) count = null;
  } catch {
    // No optimistic "not pending" claim on access-denied or WMI failure.
    count = null;
  }
  const observation: UacObservation =
    count === null ? 'unknown' : count > 0 ? 'pending' : 'clear';
  let reachable = false;
  let elevated = false;
  if (options.broker) {
    try {
      const probe = await options.broker.probe();
      reachable = probe.reachable;
      elevated = probe.reachable && probe.elevated;
    } catch {
      // The pre-authorized Broker being offline never grants privileges.
    }
  }
  const canRoute =
    options.accessMode === 'full' && elevated;

  let recommendedAction: WindowsUacStatus['recommendedAction'];
  let message: string;
  if (observation === 'unknown') {
    recommendedAction = 'investigate_process_visibility';
    message =
      'Cannot determine whether consent.exe is pending in this session. No automatic approval attempted.';
  } else if (observation === 'pending') {
    recommendedAction = canRoute
      ? 'use_preapproved_installer_broker'
      : 'local_user_consent_required';
    message = canRoute
      ? 'consent.exe exists. An existing secure desktop dialog is not controlled or dismissed. For a NEW machine-preapproved installer job, use windows_installer_apply through the existing elevated Broker.'
      : 'consent.exe exists. Without an authorized FULL Broker workflow, the current Windows UAC prompt needs local user consent.';
  } else {
    recommendedAction = canRoute
      ? 'use_preapproved_installer_broker'
      : 'no_uac_prompt_detected';
    message = canRoute
      ? 'No consent.exe detected in this session. Machine-preapproved installer jobs can be submitted through the already elevated Broker without opening a new UAC prompt.'
      : 'No consent.exe process detected in this session. This is a point-in-time observation, not proof UAC is disabled.';
  }
  return {
    observation,
    consentProcessCount: count,
    currentSessionOnly: true,
    accessMode: options.accessMode,
    brokerReachable: reachable,
    brokerElevated: elevated,
    recommendedAction,
    autoClickConsentSupported: false,
    message,
  };
}
