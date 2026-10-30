import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {NEXOWIRE_VERSION} from '../version.js';

const FailureCode = z.enum([
  'AGENT_JOURNAL_WAL_CORRUPT', 'AGENT_JOURNAL_CORRUPT',
  'AGENT_JOURNAL_FILE_INVALID', 'AGENT_JOURNAL_SIDECAR_INVALID',
  'AGENT_JOURNAL_IN_USE', 'NATIVE_AGENT_INITIALIZATION_FAILED',
]);
const Diagnostic = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1).max(64),
  processId: z.number().int().positive().max(0x7fffffff).optional(),
  startupNonce: z.string().uuid().optional(),
  recordedAt: z.string().datetime(),
  phase: z.enum(['initialization-failed', 'local-state-ready']),
  failureCode: FailureCode.nullable(),
  consecutiveFailures: z.number().int().min(0).max(999),
  restartLoopDetected: z.boolean(),
  automaticJournalRepair: z.literal(false),
  activeConnectionVerified: z.literal(false),
  coreAuthorityVerified: z.literal(false),
}).strict().refine(value =>
  value.restartLoopDetected === (value.consecutiveFailures >= 3) &&
  (value.phase === 'initialization-failed'
    ? value.failureCode !== null && value.consecutiveFailures > 0
    : value.failureCode === null && value.consecutiveFailures === 0),
{message: 'Inconsistent initialization diagnostic'});

export type NativeAgentStartupDiagnostic = z.infer<typeof Diagnostic>;
type Options = {env?: NodeJS.ProcessEnv; homeDir?: string};

export function nativeAgentStartupDiagnosticPath(options: Options = {}): string {
  const journal = options.env?.NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE?.trim();
  const root = journal ? path.dirname(path.resolve(journal))
    : path.join(options.homeDir ?? os.homedir(), '.nexowire');
  return path.join(root, 'native-agent', 'startup-diagnostic.json');
}

// This is a bounded, informational snapshot. Never use it as connectivity,
// enrollment, CORE, integrity or replay authority. Never store exception text,
// command output, journal rows, endpoint URLs, credentials or filesystem paths.
export async function readNativeAgentStartupDiagnostic(options: Options = {}):
  Promise<NativeAgentStartupDiagnostic | null> {
  const file = nativeAgentStartupDiagnosticPath(options);
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096) return null;
    const handle = await fs.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) return null;
      const bytes = Buffer.alloc(4097);
      const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (bytesRead > 4096 || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs) return null;
      return Diagnostic.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    } finally { await handle.close(); }
  } catch { return null; }
}

async function record(phase: NativeAgentStartupDiagnostic['phase'],
  error: unknown, options: Options): Promise<void> {
  const previous = await readNativeAgentStartupDiagnostic(options);
  const failed = phase === 'initialization-failed';
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? FailureCode.safeParse(error.code) : null;
  const consecutiveFailures = failed
    ? Math.min(999, (previous?.consecutiveFailures ?? 0) + 1) : 0;
  const value: NativeAgentStartupDiagnostic = {
    schemaVersion: 1, version: NEXOWIRE_VERSION,
    processId: process.pid,
    ...(options.env?.NEXOWIRE_UPDATE_STARTUP_NONCE &&
      z.string().uuid().safeParse(options.env.NEXOWIRE_UPDATE_STARTUP_NONCE).success
      ? {startupNonce: options.env.NEXOWIRE_UPDATE_STARTUP_NONCE} : {}),
    recordedAt: new Date().toISOString(), phase,
    failureCode: failed ? code?.success ? code.data : 'NATIVE_AGENT_INITIALIZATION_FAILED' : null,
    consecutiveFailures, restartLoopDetected: consecutiveFailures >= 3,
    automaticJournalRepair: false, activeConnectionVerified: false,
    coreAuthorityVerified: false,
  };
  const file = nativeAgentStartupDiagnosticPath(options);
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, {force: true}); }
}

/** Keep the original failure and the journal untouched if diagnostic I/O fails. */
export async function initializeNativeAgentState<T>(initialize: () => Promise<T>,
  options: Options = {}): Promise<T> {
  let result: T;
  try {
    result = await initialize();
  } catch (error) {
    await record('initialization-failed', error, options).catch(() => {});
    throw error;
  }
  await record('local-state-ready', null, options).catch(() => {});
  return result;
}
