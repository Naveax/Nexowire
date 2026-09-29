import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import type { Capability } from '../protocol/capabilities.js';
import { PathPolicy, PathDeniedError } from './path-policy.js';
import { executeWindowsCapability } from './windows-control.js';
import { executeWindowsEnvironmentCapability } from './windows-environment.js';
import { executeWindowsWindowCapability } from './windows-window-control.js';
import { captureWindowsScreenshot } from './windows-screenshot.js';
import { executeWindowsInputCapability } from './windows-input.js';
import { executeWindowsAccessibilityCapability } from './windows-accessibility.js';
import { executeWindowsPointerCapability } from './windows-pointer.js';
import { executeBrowserCapability } from './browser-control.js';
import { executeSystemCapability } from './system-control.js';
import type { ProcessManager } from './process-manager.js';
import type { TaskGraphStore, TaskGraphCheckpoint } from './task-graph-store.js';
import type { ArtifactStore } from './artifact-store.js';

const ShellExecInputSchema = z.object({
  command: z.string().min(1).max(200_000),
  shell: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']).optional(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(100).max(600_000).default(60_000),
  max_output_bytes: z.number().int().min(1024).max(16_777_216).default(2_097_152),
});

const WslExecInputSchema = z.object({
  command: z.string().min(1).max(200_000),
  distro: z.string().min(1).max(128).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  timeout_ms: z.number().int().min(100).max(600_000).default(60_000),
  max_output_bytes: z.number().int().min(1024).max(16_777_216).default(2_097_152),
});

const FileReadInputSchema = z.object({
  path: z.string().min(1).max(4096),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  max_bytes: z.number().int().min(1).max(16_777_216).default(2_097_152),
  include_sha256: z.boolean().default(false),
});

const FileReadManyInputSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  max_bytes_each: z.number().int().min(1).max(16_777_216).default(2_097_152),
  max_total_bytes: z.number().int().min(1024).max(67_108_864).default(16_777_216),
  include_sha256: z.boolean().default(false),
});

const SearchTextInputSchema = z.object({
  path: z.string().min(1).max(4096),
  query: z.string().min(1).max(2000),
  regex: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  max_matches: z.number().int().min(1).max(5000).default(200),
  max_files: z.number().int().min(1).max(100_000).default(10_000),
  max_file_bytes: z.number().int().min(1024).max(16_777_216).default(2_097_152),
  include_hidden: z.boolean().default(false),
  exclude_dirs: z.array(z.string().min(1).max(255)).max(100).default([
    '.git', 'node_modules', 'dist', 'build', 'target', '.next', '.venv', 'vendor',
  ]),
});

const FileWriteInputSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(22_369_624),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  mode: z.enum(['overwrite', 'append']).default('overwrite'),
  create_parents: z.boolean().default(false),
});

const FileStatInputSchema = z.object({
  path: z.string().min(1).max(4096),
});

const FileHashInputSchema = z.object({
  path: z.string().min(1).max(4096),
  max_bytes: z.number().int().min(1).max(268_435_456).default(67_108_864),
});

const FileMkdirInputSchema = z.object({
  path: z.string().min(1).max(4096),
  recursive: z.boolean().default(true),
});

const FileTransferInputSchema = z.object({
  source: z.string().min(1).max(4096),
  destination: z.string().min(1).max(4096),
  overwrite: z.boolean().default(false),
  recursive: z.boolean().default(false),
  create_parents: z.boolean().default(false),
});

const FileDeleteInputSchema = z.object({
  path: z.string().min(1).max(4096),
  recursive: z.boolean().default(false),
});

const FilePatchInputSchema = z.object({
  path: z.string().min(1).max(4096),
  operations: z.array(z.object({
    old_text: z.string().min(1).max(1_048_576),
    new_text: z.string().max(1_048_576),
    expected_count: z.number().int().min(1).max(10_000).default(1),
  })).min(1).max(100),
  max_bytes: z.number().int().min(1).max(16_777_216).default(4_194_304),
  expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
});

const FileListInputSchema = z.object({
  path: z.string().min(1).max(4096),
  depth: z.number().int().min(1).max(5).default(2),
  max_entries: z.number().int().min(1).max(5000).default(1000),
});

const WorkspaceSnapshotInputSchema = z.object({
  path: z.string().min(1).max(4096),
});

const WorkspaceDetectInputSchema = z.object({
  path: z.string().min(1).max(4096),
});

const WorkspaceChecksInputSchema = z.object({
  path: z.string().min(1).max(4096),
  checks: z.array(z.string().min(1).max(128)).min(1).max(8),
  parallel: z.boolean().default(true),
  timeout_ms: z.number().int().min(100).max(600_000).default(120_000),
  max_output_bytes: z
    .number()
    .int()
    .min(1024)
    .max(16_777_216)
    .default(2_097_152),
});

const TaskGraphJobIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const TaskGraphJobSchema = z.object({
  id: TaskGraphJobIdSchema,
  command: z.string().min(1).max(200_000),
  shell: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']).optional(),
  cwd: z.string().max(4096).optional(),
  depends_on: z.array(TaskGraphJobIdSchema).max(31).default([]),
  timeout_ms: z.number().int().min(100).max(600_000).optional(),
  max_output_bytes: z
    .number()
    .int()
    .min(1024)
    .max(16_777_216)
    .optional(),
});

const TaskGraphRunInputSchema = z.object({
  graph_id: TaskGraphJobIdSchema.optional(),
  resume: z.boolean().default(false),
  retry_failed: z.boolean().default(false),
  retry_unknown: z.boolean().default(false),
  jobs: z.array(TaskGraphJobSchema).min(1).max(32),
  max_parallel: z.number().int().min(1).max(8).default(4),
  stop_on_failure: z.boolean().default(false),
  default_timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(600_000)
    .default(120_000),
  total_timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .default(600_000),
  default_max_output_bytes: z
    .number()
    .int()
    .min(1024)
    .max(16_777_216)
    .default(1_048_576),
});

const TaskGraphGetInputSchema = z.object({
  graph_id: TaskGraphJobIdSchema,
});

const TaskGraphPruneInputSchema = z.object({
  older_than_ms: z
    .number()
    .int()
    .min(0)
    .max(2_592_000_000)
    .optional(),
});

const ArtifactKindInputSchema = z.enum([
  'build',
  'test',
  'report',
  'log',
  'package',
  'archive',
  'image',
  'binary',
  'other',
]);

const ArtifactRegisterInputSchema = z.object({
  path: z.string().min(1).max(4096),
  label: z.string().min(1).max(256).optional(),
  kind: ArtifactKindInputSchema.default('other'),
  source_graph_id: z.string().min(1).max(128).optional(),
  source_job_id: z.string().min(1).max(128).optional(),
  max_hash_bytes: z
    .number()
    .int()
    .min(1)
    .max(4_294_967_296)
    .default(536_870_912),
});

const ArtifactListInputSchema = z.object({
  graph_id: z.string().min(1).max(128).optional(),
  job_id: z.string().min(1).max(128).optional(),
  kind: ArtifactKindInputSchema.optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});

const ArtifactGetInputSchema = z.object({
  artifact_id: z.string().uuid(),
});

const ArtifactVerifyInputSchema = z.object({
  artifact_id: z.string().uuid(),
  max_hash_bytes: z
    .number()
    .int()
    .min(1)
    .max(4_294_967_296)
    .default(536_870_912),
});

const ArtifactPruneInputSchema = z.object({
  older_than_ms: z
    .number()
    .int()
    .min(0)
    .max(31_536_000_000)
    .optional(),
  remove_missing: z.boolean().default(false),
});

class FileConflictError extends Error {
  readonly code = 'FILE_CONFLICT';

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FileConflictError';
  }
}

function sha256Buffer(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function sha256File(target: string, maxBytes?: number): Promise<string> {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Hash target is not a file.');
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new Error(`File size ${stat.size} exceeds hash max_bytes ${maxBytes}.`);
  }
  return sha256Buffer(await fs.readFile(target));
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

function appendLimited(
  current: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  limit: number,
): void {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const remaining = limit - state.bytes;
  const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  current.push(slice);
  state.bytes += slice.byteLength;
  if (slice.byteLength < chunk.byteLength) state.truncated = true;
}

async function terminateProcessTree(
  child: ChildProcess,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGKILL');
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2_097_152;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) =>
      appendLimited(stdout, chunk, stdoutState, maxOutputBytes),
    );
    child.stderr.on('data', (chunk: Buffer) =>
      appendLimited(stderr, chunk, stderrState, maxOutputBytes),
    );

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        truncated: stdoutState.truncated || stderrState.truncated,
        timedOut,
      });
    });
  });
}

function hasExecutable(command: string): boolean {
  const result = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [command],
    { windowsHide: true, stdio: 'ignore' },
  );
  return result.status === 0;
}

function shellCommand(
  shell: z.infer<typeof ShellExecInputSchema>['shell'],
  command: string,
): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    const selected =
      shell ?? (hasExecutable('pwsh.exe') ? 'pwsh' : 'powershell');
    if (selected === 'pwsh') {
      return {
        executable: 'pwsh.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      };
    }
    if (selected === 'powershell') {
      return {
        executable: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      };
    }
    if (selected === 'cmd') {
      return { executable: 'cmd.exe', args: ['/D', '/S', '/C', command] };
    }
    return { executable: selected, args: ['-lc', command] };
  }

  const selected = shell === 'sh' ? 'sh' : 'bash';
  return { executable: selected, args: ['-lc', command] };
}

async function executeShell(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = ShellExecInputSchema.parse(input);
  const cwd = parsed.cwd ? await policy.resolveExisting(parsed.cwd) : undefined;
  const command = shellCommand(parsed.shell, parsed.command);
  const result = await runProcess(command.executable, command.args, {
    ...(cwd ? { cwd } : {}),
    timeoutMs: parsed.timeout_ms,
    maxOutputBytes: parsed.max_output_bytes,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
    data: { timedOut: result.timedOut },
  };
}

async function executeWsl(input: unknown): Promise<unknown> {
  if (process.platform !== 'win32') {
    throw new Error('wsl.exec is only available from a Windows native agent.');
  }

  const parsed = WslExecInputSchema.parse(input);
  const args: string[] = [];
  if (parsed.distro) args.push('--distribution', parsed.distro);
  if (parsed.cwd) args.push('--cd', parsed.cwd);
  args.push('--', 'bash', '-lc', parsed.command);

  const result = await runProcess('wsl.exe', args, {
    timeoutMs: parsed.timeout_ms,
    maxOutputBytes: parsed.max_output_bytes,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
    data: { timedOut: result.timedOut },
  };
}

async function readFile(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileReadInputSchema.parse(input);
  const target = await policy.resolveExisting(parsed.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Requested path is not a file.');
  if (stat.size > parsed.max_bytes) {
    throw new Error(
      `File size ${stat.size} exceeds max_bytes ${parsed.max_bytes}.`,
    );
  }
  const content = await fs.readFile(target);
  return {
    data: {
      path: target,
      size: stat.size,
      encoding: parsed.encoding,
      ...(parsed.include_sha256 ? { sha256: sha256Buffer(content) } : {}),
      content:
        parsed.encoding === 'base64'
          ? content.toString('base64')
          : content.toString('utf8'),
    },
  };
}

async function readManyFiles(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileReadManyInputSchema.parse(input);
  let totalBytes = 0;
  let truncated = false;
  const results: Array<Record<string, unknown>> = [];

  for (const requested of parsed.paths) {
    try {
      const target = await policy.resolveExisting(requested);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error('Requested path is not a file.');
      if (stat.size > parsed.max_bytes_each) {
        throw new Error(`File size ${stat.size} exceeds max_bytes_each ${parsed.max_bytes_each}.`);
      }
      if (totalBytes + stat.size > parsed.max_total_bytes) {
        truncated = true;
        results.push({ path: target, ok: false, error: 'TOTAL_LIMIT_REACHED', size: stat.size });
        continue;
      }
      const content = await fs.readFile(target);
      totalBytes += content.byteLength;
      results.push({
        path: target,
        ok: true,
        size: stat.size,
        encoding: parsed.encoding,
        ...(parsed.include_sha256 ? { sha256: sha256Buffer(content) } : {}),
        content:
          parsed.encoding === 'base64'
            ? content.toString('base64')
            : content.toString('utf8'),
      });
    } catch (error) {
      results.push({
        path: requested,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { data: { results, totalBytes, truncated } };
}

async function writeFile(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileWriteInputSchema.parse(input);
  const target = await policy.resolveForCreate(parsed.path);
  if (parsed.create_parents) {
    await fs.mkdir(path.dirname(target), { recursive: true });
  }

  const content =
    parsed.encoding === 'base64'
      ? Buffer.from(parsed.content, 'base64')
      : Buffer.from(parsed.content, 'utf8');

  if (parsed.mode === 'append') {
    await fs.appendFile(target, content);
  } else {
    await fs.writeFile(target, content);
  }

  return { data: { path: target, bytesWritten: content.byteLength } };
}

async function statPath(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileStatInputSchema.parse(input);
  const target = await policy.resolveExisting(parsed.path);
  const stat = await fs.lstat(target);
  return {
    data: {
      path: target,
      type: stat.isSymbolicLink()
        ? 'symlink'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'other',
      size: stat.size,
      mode: stat.mode,
      modifiedAt: stat.mtime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
    },
  };
}

async function hashFile(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileHashInputSchema.parse(input);
  const target = await policy.resolveExisting(parsed.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Hash target is not a file.');
  if (stat.size > parsed.max_bytes) {
    throw new Error(`File size ${stat.size} exceeds hash max_bytes ${parsed.max_bytes}.`);
  }
  return {
    data: {
      path: target,
      size: stat.size,
      sha256: await sha256File(target, parsed.max_bytes),
      modifiedAt: stat.mtime.toISOString(),
    },
  };
}

async function makeDirectory(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileMkdirInputSchema.parse(input);
  const target = await policy.resolveForCreate(parsed.path);
  await fs.mkdir(target, { recursive: parsed.recursive });
  return { data: { path: target, created: true } };
}

async function copyPath(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileTransferInputSchema.parse(input);
  const source = await policy.resolveExisting(parsed.source);
  const destination = await policy.resolveForCreate(parsed.destination);
  if (parsed.create_parents) await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: parsed.recursive,
    force: parsed.overwrite,
    errorOnExist: !parsed.overwrite,
    preserveTimestamps: true,
  });
  return { data: { source, destination } };
}

async function movePath(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileTransferInputSchema.parse(input);
  const source = await policy.resolveExisting(parsed.source);
  const destination = await policy.resolveForCreate(parsed.destination);
  if (parsed.create_parents) await fs.mkdir(path.dirname(destination), { recursive: true });

  if (!parsed.overwrite) {
    try {
      await fs.lstat(destination);
      throw new Error('Destination already exists.');
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  } else {
    await fs.rm(destination, { recursive: true, force: true });
  }

  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EXDEV')) throw error;
    const stat = await fs.lstat(source);
    await fs.cp(source, destination, { recursive: stat.isDirectory(), preserveTimestamps: true });
    await fs.rm(source, { recursive: stat.isDirectory(), force: true });
  }
  return { data: { source, destination } };
}

async function deletePath(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FileDeleteInputSchema.parse(input);
  const target = await policy.resolveExisting(parsed.path);
  const stat = await fs.lstat(target);
  if (stat.isDirectory() && !parsed.recursive) {
    await fs.rmdir(target);
  } else {
    await fs.rm(target, { recursive: parsed.recursive, force: false });
  }
  return { data: { path: target, deleted: true } };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count++;
    offset = index + needle.length;
  }
}

async function patchFile(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = FilePatchInputSchema.parse(input);
  const target = await policy.resolveExisting(parsed.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Patch target is not a file.');
  if (stat.size > parsed.max_bytes) {
    throw new Error(`Patch target exceeds max_bytes ${parsed.max_bytes}.`);
  }

  const originalBuffer = await fs.readFile(target);
  const originalSha256 = sha256Buffer(originalBuffer);
  if (
    parsed.expected_sha256 &&
    parsed.expected_sha256.toLowerCase() !== originalSha256
  ) {
    throw new FileConflictError(
      'Patch target no longer matches expected_sha256.',
      {
        path: target,
        expectedSha256: parsed.expected_sha256.toLowerCase(),
        actualSha256: originalSha256,
      },
    );
  }

  let content = originalBuffer.toString('utf8');
  const applied: Array<{ index: number; replacements: number }> = [];
  for (let index = 0; index < parsed.operations.length; index++) {
    const operation = parsed.operations[index]!;
    const count = countOccurrences(content, operation.old_text);
    if (count !== operation.expected_count) {
      throw new FileConflictError(
        `Patch operation ${index + 1} expected ${operation.expected_count} occurrence(s), found ${count}.`,
        {
          path: target,
          operation: index + 1,
          expectedCount: operation.expected_count,
          actualCount: count,
          originalSha256,
        },
      );
    }
    content = content.split(operation.old_text).join(operation.new_text);
    applied.push({ index, replacements: count });
  }

  const finalBuffer = Buffer.from(content, 'utf8');
  const finalSha256 = sha256Buffer(finalBuffer);
  const temp = `${target}.nexowire-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, finalBuffer);
    await fs.chmod(temp, stat.mode);

    const beforeCommitSha256 = await sha256File(target, parsed.max_bytes);
    if (beforeCommitSha256 !== originalSha256) {
      throw new FileConflictError(
        'Patch target changed while the patch was being prepared.',
        {
          path: target,
          originalSha256,
          actualSha256: beforeCommitSha256,
        },
      );
    }

    if (process.platform === 'win32') {
      await fs.copyFile(temp, target);
      await fs.rm(temp, { force: true });
    } else {
      await fs.rename(temp, target);
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }

  return {
    data: {
      path: target,
      applied,
      bytes: finalBuffer.byteLength,
      originalSha256,
      sha256: finalSha256,
    },
  };
}

interface ListedEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
}

async function listDirectory(
  input: unknown,
  policy: PathPolicy,
): Promise<unknown> {
  const parsed = FileListInputSchema.parse(input);
  const root = await policy.resolveExisting(parsed.path);
  const entries: ListedEntry[] = [];

  const walk = async (dir: string, remainingDepth: number): Promise<void> => {
    if (entries.length >= parsed.max_entries) return;
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (entries.length >= parsed.max_entries) break;
      const fullPath = path.join(dir, dirent.name);
      const relative = path.relative(root, fullPath) || '.';
      if (dirent.isSymbolicLink()) {
        entries.push({ path: relative, type: 'symlink' });
        continue;
      }
      if (dirent.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        if (remainingDepth > 1) await walk(fullPath, remainingDepth - 1);
        continue;
      }
      if (dirent.isFile()) {
        const stat = await fs.stat(fullPath);
        entries.push({ path: relative, type: 'file', size: stat.size });
        continue;
      }
      entries.push({ path: relative, type: 'other' });
    }
  };

  await walk(root, parsed.depth);
  return {
    data: {
      root,
      entries,
      truncated: entries.length >= parsed.max_entries,
    },
  };
}

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

async function searchText(input: unknown, policy: PathPolicy): Promise<unknown> {
  const parsed = SearchTextInputSchema.parse(input);
  const root = await policy.resolveExisting(parsed.path);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error('Search path is not a directory.');

  let matcher: RegExp | undefined;
  if (parsed.regex) {
    matcher = new RegExp(parsed.query, parsed.case_sensitive ? 'g' : 'gi');
  }
  const needle = parsed.case_sensitive ? parsed.query : parsed.query.toLowerCase();
  const excluded = new Set(parsed.exclude_dirs.map((value) => value.toLowerCase()));
  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) break;
      if (!parsed.include_hidden && entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skippedFiles++;
        continue;
      }
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase())) continue;
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (scannedFiles >= parsed.max_files) {
        truncated = true;
        break;
      }
      scannedFiles++;
      const stat = await fs.stat(fullPath);
      if (stat.size > parsed.max_file_bytes) {
        skippedFiles++;
        continue;
      }
      const buffer = await fs.readFile(fullPath);
      if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
        skippedFiles++;
        continue;
      }
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        let column = -1;
        if (matcher) {
          matcher.lastIndex = 0;
          const result = matcher.exec(line);
          column = result?.index ?? -1;
        } else {
          const haystack = parsed.case_sensitive ? line : line.toLowerCase();
          column = haystack.indexOf(needle);
        }
        if (column < 0) continue;
        matches.push({
          path: path.relative(root, fullPath) || entry.name,
          line: index + 1,
          column: column + 1,
          text: line.length > 2000 ? line.slice(0, 2000) : line,
        });
        if (matches.length >= parsed.max_matches) {
          truncated = true;
          break;
        }
      }
    }
  };

  await walk(root);
  return {
    data: {
      root,
      query: parsed.query,
      matches,
      scannedFiles,
      skippedFiles,
      truncated,
    },
  };
}

function listWslDistros(): string[] {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('wsl.exe', ['--list', '--quiet'], {
    windowsHide: true,
    encoding: 'utf16le',
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .replaceAll('\u0000', '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function machineSnapshot(policy: PathPolicy): Promise<unknown> {
  return {
    data: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
      user: os.userInfo().username,
      home: os.homedir(),
      cwd: process.cwd(),
      node: process.version,
      allowedRoots: policy.describe(),
      wslDistros: listWslDistros(),
    },
  };
}


interface WorkspaceCheckSpec {
  id: string;
  label: string;
  kind: string;
  executable: string;
  args: string[];
  cwd: string;
  executableAvailable: boolean;
}

interface WorkspaceDetection {
  requestedPath: string;
  root: string;
  gitRoot: boolean;
  kinds: string[];
  manifests: string[];
  packageManager?: string;
  nodeScripts?: string[];
  checkSpecs: WorkspaceCheckSpec[];
}

async function resolveWorkspaceRoot(cwd: string): Promise<{
  root: string;
  gitRoot: boolean;
}> {
  if (!hasExecutable('git')) return { root: cwd, gitRoot: false };

  try {
    const result = await runProcess(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { timeoutMs: 10_000, maxOutputBytes: 131_072 },
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { root: result.stdout.trim(), gitRoot: true };
    }
  } catch {
    // Non-Git workspaces are still valid workspaces.
  }
  return { root: cwd, gitRoot: false };
}

function commandDisplay(executable: string, args: readonly string[]): string {
  const quote = (value: string): string =>
    /[\s"]/u.test(value) ? JSON.stringify(value) : value;
  return [executable, ...args].map(quote).join(' ');
}

function nodePackageManagerExecutable(manager: string): string {
  if (
    process.platform === 'win32' &&
    ['npm', 'pnpm', 'yarn'].includes(manager)
  ) {
    return manager + '.cmd';
  }
  return manager;
}

function pushWorkspaceCheck(
  checks: WorkspaceCheckSpec[],
  spec: Omit<WorkspaceCheckSpec, 'executableAvailable'>,
): void {
  checks.push({
    ...spec,
    executableAvailable: hasExecutable(spec.executable),
  });
}

async function detectWorkspaceInternal(
  input: unknown,
  policy: PathPolicy,
): Promise<WorkspaceDetection> {
  const parsed = WorkspaceDetectInputSchema.parse(input);
  const requestedPath = await policy.resolveExisting(parsed.path);
  const requestedStat = await fs.stat(requestedPath);
  if (!requestedStat.isDirectory()) {
    throw new Error('Workspace path is not a directory.');
  }

  const resolved = await resolveWorkspaceRoot(requestedPath);
  const root = await policy.resolveExisting(resolved.root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const dirs = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );

  const kinds: string[] = [];
  const manifests: string[] = [];
  const checkSpecs: WorkspaceCheckSpec[] = [];
  let packageManager: string | undefined;
  let nodeScripts: string[] | undefined;

  if (names.has('package.json')) {
    kinds.push('node');
    manifests.push('package.json');
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      packageManager?: unknown;
      scripts?: unknown;
    };

    if (typeof pkg.packageManager === 'string') {
      const candidate = pkg.packageManager.split('@')[0]?.trim();
      if (candidate) packageManager = candidate;
    }
    packageManager ??= names.has('bun.lock') || names.has('bun.lockb')
      ? 'bun'
      : names.has('pnpm-lock.yaml')
        ? 'pnpm'
        : names.has('yarn.lock')
          ? 'yarn'
          : 'npm';

    const scripts =
      typeof pkg.scripts === 'object' && pkg.scripts !== null
        ? (pkg.scripts as Record<string, unknown>)
        : {};
    nodeScripts = Object.entries(scripts)
      .filter(([, value]) => typeof value === 'string')
      .map(([name]) => name)
      .sort();

    const checkNames = [
      'typecheck',
      'test',
      'build',
      'lint',
      'check',
      'format:check',
      'format-check',
    ];
    const managerExecutable = nodePackageManagerExecutable(packageManager);
    const managerAvailable = hasExecutable(managerExecutable);
    for (const scriptName of checkNames) {
      if (typeof scripts[scriptName] !== 'string') continue;

      if (
        process.platform === 'win32' &&
        ['npm', 'pnpm', 'yarn'].includes(packageManager)
      ) {
        checkSpecs.push({
          id: 'node:' + scriptName,
          label: 'Node script ' + scriptName,
          kind: 'node',
          executable: process.env.ComSpec || 'cmd.exe',
          args: [
            '/D',
            '/S',
            '/C',
            `${managerExecutable} run ${scriptName}`,
          ],
          cwd: root,
          executableAvailable: managerAvailable,
        });
        continue;
      }

      checkSpecs.push({
        id: 'node:' + scriptName,
        label: 'Node script ' + scriptName,
        kind: 'node',
        executable: managerExecutable,
        args: ['run', scriptName],
        cwd: root,
        executableAvailable: managerAvailable,
      });
    }
  }

  if (names.has('Cargo.toml')) {
    kinds.push('rust');
    manifests.push('Cargo.toml');
    for (const [id, args, label] of [
      ['rust:check', ['check'], 'Cargo check'],
      ['rust:test', ['test'], 'Cargo test'],
      ['rust:build', ['build'], 'Cargo build'],
    ] as const) {
      pushWorkspaceCheck(checkSpecs, {
        id,
        label,
        kind: 'rust',
        executable: process.platform === 'win32' ? 'cargo.exe' : 'cargo',
        args: [...args],
        cwd: root,
      });
    }
  }

  if (names.has('go.mod')) {
    kinds.push('go');
    manifests.push('go.mod');
    for (const [id, args, label] of [
      ['go:test', ['test', './...'], 'Go test'],
      ['go:vet', ['vet', './...'], 'Go vet'],
      ['go:build', ['build', './...'], 'Go build'],
    ] as const) {
      pushWorkspaceCheck(checkSpecs, {
        id,
        label,
        kind: 'go',
        executable: process.platform === 'win32' ? 'go.exe' : 'go',
        args: [...args],
        cwd: root,
      });
    }
  }

  const solution = files.find((name) => name.toLowerCase().endsWith('.sln'));
  const csproj = files.find((name) =>
    name.toLowerCase().endsWith('.csproj'),
  );
  if (solution || csproj) {
    kinds.push('dotnet');
    if (solution) manifests.push(solution);
    if (csproj) manifests.push(csproj);
    const project = solution ?? csproj!;
    for (const [id, verb, label] of [
      ['dotnet:build', 'build', '.NET build'],
      ['dotnet:test', 'test', '.NET test'],
    ] as const) {
      pushWorkspaceCheck(checkSpecs, {
        id,
        label,
        kind: 'dotnet',
        executable: process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
        args: [verb, project],
        cwd: root,
      });
    }
  }

  const pythonMarkers = [
    'pyproject.toml',
    'requirements.txt',
    'setup.py',
    'setup.cfg',
  ].filter((name) => names.has(name));
  if (pythonMarkers.length > 0) {
    kinds.push('python');
    manifests.push(...pythonMarkers);

    const hasTests =
      dirs.has('tests') ||
      names.has('pytest.ini') ||
      names.has('tox.ini') ||
      names.has('pyproject.toml');
    if (hasTests && hasExecutable('pytest')) {
      pushWorkspaceCheck(checkSpecs, {
        id: 'python:pytest',
        label: 'Pytest',
        kind: 'python',
        executable:
          process.platform === 'win32' ? 'pytest.exe' : 'pytest',
        args: [],
        cwd: root,
      });
    }
    if (
      (names.has('ruff.toml') ||
        names.has('.ruff.toml') ||
        names.has('pyproject.toml')) &&
      hasExecutable('ruff')
    ) {
      pushWorkspaceCheck(checkSpecs, {
        id: 'python:ruff',
        label: 'Ruff check',
        kind: 'python',
        executable: process.platform === 'win32' ? 'ruff.exe' : 'ruff',
        args: ['check', '.'],
        cwd: root,
      });
    }
    if (
      (names.has('mypy.ini') ||
        names.has('.mypy.ini') ||
        names.has('pyproject.toml')) &&
      hasExecutable('mypy')
    ) {
      pushWorkspaceCheck(checkSpecs, {
        id: 'python:mypy',
        label: 'Mypy',
        kind: 'python',
        executable: process.platform === 'win32' ? 'mypy.exe' : 'mypy',
        args: ['.'],
        cwd: root,
      });
    }
  }

  if (names.has('CMakeLists.txt')) {
    kinds.push('cmake');
    manifests.push('CMakeLists.txt');
  }

  return {
    requestedPath,
    root,
    gitRoot: resolved.gitRoot,
    kinds: [...new Set(kinds)],
    manifests: [...new Set(manifests)],
    ...(packageManager ? { packageManager } : {}),
    ...(nodeScripts ? { nodeScripts } : {}),
    checkSpecs,
  };
}

async function workspaceDetect(
  input: unknown,
  policy: PathPolicy,
): Promise<unknown> {
  const detection = await detectWorkspaceInternal(input, policy);
  return {
    data: {
      requestedPath: detection.requestedPath,
      root: detection.root,
      gitRoot: detection.gitRoot,
      kinds: detection.kinds,
      manifests: detection.manifests,
      ...(detection.packageManager
        ? { packageManager: detection.packageManager }
        : {}),
      ...(detection.nodeScripts
        ? { nodeScripts: detection.nodeScripts }
        : {}),
      availableChecks: detection.checkSpecs.map((check) => ({
        id: check.id,
        label: check.label,
        kind: check.kind,
        command: commandDisplay(check.executable, check.args),
        executableAvailable: check.executableAvailable,
      })),
    },
  };
}

async function workspaceChecks(
  input: unknown,
  policy: PathPolicy,
): Promise<unknown> {
  const parsed = WorkspaceChecksInputSchema.parse(input);
  const detection = await detectWorkspaceInternal(
    { path: parsed.path },
    policy,
  );
  const byId = new Map(
    detection.checkSpecs.map((check) => [check.id, check] as const),
  );

  const selected = parsed.checks.map((id) => {
    const check = byId.get(id);
    if (!check) {
      throw new Error(
        `Workspace check "${id}" is not available. Detect the workspace first and choose an advertised check id.`,
      );
    }
    return check;
  });

  const runOne = async (check: WorkspaceCheckSpec) => {
    const started = Date.now();
    if (!check.executableAvailable) {
      return {
        id: check.id,
        label: check.label,
        kind: check.kind,
        command: commandDisplay(check.executable, check.args),
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: 0,
        error: `Executable is not available: ${check.executable}`,
      };
    }

    try {
      const result = await runProcess(check.executable, check.args, {
        cwd: check.cwd,
        timeoutMs: parsed.timeout_ms,
        maxOutputBytes: parsed.max_output_bytes,
      });
      return {
        id: check.id,
        label: check.label,
        kind: check.kind,
        command: commandDisplay(check.executable, check.args),
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        id: check.id,
        label: check.label,
        kind: check.kind,
        command: commandDisplay(check.executable, check.args),
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const results = parsed.parallel
    ? await Promise.all(selected.map(runOne))
    : await (async () => {
        const output = [];
        for (const check of selected) output.push(await runOne(check));
        return output;
      })();

  return {
    data: {
      root: detection.root,
      parallel: parsed.parallel,
      ok: results.every((result) => result.ok),
      passed: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    },
  };
}


type TaskGraphStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'unknown';

interface TaskGraphResult {
  id: string;
  status: TaskGraphStatus;
  dependsOn: string[];
  command: string;
  shell: string;
  cwd?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  timedOut?: boolean;
  error?: string;
  blockedBy?: string[];
  attempts?: number;
  reused?: boolean;
}

function validateTaskGraph(
  jobs: z.infer<typeof TaskGraphJobSchema>[],
): void {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.id)) {
      throw new Error(`Duplicate task graph job id: ${job.id}`);
    }
    ids.add(job.id);
  }

  for (const job of jobs) {
    for (const dependency of job.depends_on) {
      if (dependency === job.id) {
        throw new Error(`Task graph job "${job.id}" cannot depend on itself.`);
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `Task graph job "${job.id}" depends on unknown job "${dependency}".`,
        );
      }
    }
  }

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const job of jobs) {
    indegree.set(job.id, job.depends_on.length);
    for (const dependency of job.depends_on) {
      const bucket = children.get(dependency) ?? [];
      bucket.push(job.id);
      children.set(dependency, bucket);
    }
  }

  const queue = jobs
    .filter((job) => (indegree.get(job.id) ?? 0) === 0)
    .map((job) => job.id);
  let visited = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  if (visited !== jobs.length) {
    throw new Error('Task graph contains a dependency cycle.');
  }
}

async function runTaskGraph(
  input: unknown,
  policy: PathPolicy,
  store?: TaskGraphStore,
): Promise<unknown> {
  const parsed = TaskGraphRunInputSchema.parse(input);
  validateTaskGraph(parsed.jobs);

  if (parsed.resume && !parsed.graph_id) {
    throw new Error('resume=true requires graph_id.');
  }
  if ((parsed.retry_failed || parsed.retry_unknown) && !parsed.resume) {
    throw new Error('retry_failed/retry_unknown require resume=true.');
  }
  if (parsed.graph_id && !store) {
    throw new Error('Persistent task graph store is unavailable.');
  }

  const specHash = sha256Buffer(
    Buffer.from(
      JSON.stringify({
        jobs: parsed.jobs,
        max_parallel: parsed.max_parallel,
        stop_on_failure: parsed.stop_on_failure,
        default_timeout_ms: parsed.default_timeout_ms,
        total_timeout_ms: parsed.total_timeout_ms,
        default_max_output_bytes: parsed.default_max_output_bytes,
      }),
      'utf8',
    ),
  );

  let checkpoint: TaskGraphCheckpoint | undefined;
  if (parsed.graph_id) {
    checkpoint = await store!.prepare({
      id: parsed.graph_id,
      specHash,
      jobs: parsed.jobs.map((job) => ({
        id: job.id,
        dependsOn: [...job.depends_on],
      })),
      resume: parsed.resume,
      retryFailed: parsed.retry_failed,
      retryUnknown: parsed.retry_unknown,
    });
  }

  const startedAt = Date.now();
  const deadline = startedAt + parsed.total_timeout_ms;
  const results = new Map<string, TaskGraphResult>();

  for (const job of parsed.jobs) {
    const saved = checkpoint?.jobs.find((entry) => entry.id === job.id);
    results.set(job.id, {
      id: job.id,
      status: saved?.status ?? 'pending',
      dependsOn: [...job.depends_on],
      command: job.command,
      shell:
        job.shell ??
        (process.platform === 'win32'
          ? hasExecutable('pwsh.exe')
            ? 'pwsh'
            : 'powershell'
          : 'bash'),
      ...(saved?.startedAt ? { startedAt: saved.startedAt } : {}),
      ...(saved?.completedAt ? { completedAt: saved.completedAt } : {}),
      ...(saved?.exitCode !== undefined ? { exitCode: saved.exitCode } : {}),
      ...(saved?.timedOut !== undefined ? { timedOut: saved.timedOut } : {}),
      ...(saved?.blockedBy ? { blockedBy: [...saved.blockedBy] } : {}),
      ...(saved ? { attempts: saved.attempts } : { attempts: 0 }),
      ...(saved && saved.status !== 'pending' ? { reused: true } : {}),
    });
  }

  const persistGraph = async (
    forcedStatus?: TaskGraphCheckpoint['status'],
  ): Promise<void> => {
    if (!parsed.graph_id || !store || !checkpoint) return;

    const ordered = parsed.jobs.map((job) => results.get(job.id)!);
    const unknown = ordered.some((result) => result.status === 'unknown');
    const running = ordered.some((result) => result.status === 'running');
    const failed = ordered.some((result) => result.status === 'failed');
    const blocked = ordered.some((result) => result.status === 'blocked');
    const status: TaskGraphCheckpoint['status'] =
      forcedStatus ??
      (unknown
        ? 'interrupted'
        : running
          ? 'running'
          : failed
            ? 'failed'
            : blocked
              ? 'blocked'
              : 'succeeded');

    checkpoint = {
      ...checkpoint,
      status,
      updatedAt: new Date().toISOString(),
      jobs: ordered.map((result) => ({
        id: result.id,
        status: result.status,
        dependsOn: [...result.dependsOn],
        attempts: result.attempts ?? 0,
        ...(result.startedAt ? { startedAt: result.startedAt } : {}),
        ...(result.completedAt ? { completedAt: result.completedAt } : {}),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        ...(result.blockedBy ? { blockedBy: [...result.blockedBy] } : {}),
      })),
    };
    await store.save(checkpoint);
  };

  const running = new Map<string, Promise<void>>();

  const startJob = (job: z.infer<typeof TaskGraphJobSchema>): void => {
    const result = results.get(job.id)!;
    result.status = 'running';
    result.reused = false;
    result.attempts = (result.attempts ?? 0) + 1;
    result.startedAt = new Date().toISOString();
    delete result.completedAt;
    delete result.blockedBy;
    delete result.error;
    delete result.exitCode;
    delete result.stdout;
    delete result.stderr;
    delete result.timedOut;
    delete result.truncated;
    const jobStartedAt = Date.now();

    const promise = (async () => {
      await persistGraph('running');
      try {
        const cwd = job.cwd
          ? await policy.resolveExisting(job.cwd)
          : undefined;
        const resolvedShell = shellCommand(job.shell, job.command);
        result.shell =
          job.shell ??
          (process.platform === 'win32'
            ? resolvedShell.executable.toLowerCase().includes('pwsh')
              ? 'pwsh'
              : resolvedShell.executable.toLowerCase().includes('powershell')
                ? 'powershell'
                : resolvedShell.executable
            : resolvedShell.executable);
        if (cwd) result.cwd = cwd;

        const remainingMs = Math.max(100, deadline - Date.now());
        const execution = await runProcess(
          resolvedShell.executable,
          resolvedShell.args,
          {
            ...(cwd ? { cwd } : {}),
            timeoutMs: Math.min(
              job.timeout_ms ?? parsed.default_timeout_ms,
              remainingMs,
            ),
            maxOutputBytes:
              job.max_output_bytes ?? parsed.default_max_output_bytes,
          },
        );

        result.exitCode = execution.exitCode;
        result.stdout = execution.stdout;
        result.stderr = execution.stderr;
        result.truncated = execution.truncated;
        result.timedOut = execution.timedOut;
        result.status =
          execution.exitCode === 0 && !execution.timedOut
            ? 'succeeded'
            : 'failed';
      } catch (error) {
        result.status = 'failed';
        result.exitCode = null;
        result.stdout = '';
        result.stderr = '';
        result.truncated = false;
        result.timedOut = false;
        result.error =
          error instanceof Error ? error.message : String(error);
      } finally {
        result.completedAt = new Date().toISOString();
        result.durationMs = Date.now() - jobStartedAt;
        await persistGraph();
      }
    })().finally(() => {
      running.delete(job.id);
    });

    running.set(job.id, promise);
  };

  while (true) {
    let changed = false;
    const anyFailed = [...results.values()].some(
      (result) => result.status === 'failed',
    );

    for (const job of parsed.jobs) {
      const result = results.get(job.id)!;
      if (result.status !== 'pending') continue;

      const dependencyResults = job.depends_on.map(
        (id) => results.get(id)!,
      );
      const blockedBy = dependencyResults
        .filter(
          (dependency) =>
            dependency.status === 'failed' ||
            dependency.status === 'blocked' ||
            dependency.status === 'unknown',
        )
        .map((dependency) => dependency.id);

      if (blockedBy.length > 0) {
        result.status = 'blocked';
        result.blockedBy = blockedBy;
        result.completedAt = new Date().toISOString();
        result.durationMs = 0;
        changed = true;
        continue;
      }

      if (parsed.stop_on_failure && anyFailed) {
        result.status = 'blocked';
        result.blockedBy = ['stop_on_failure'];
        result.completedAt = new Date().toISOString();
        result.durationMs = 0;
        changed = true;
      }
    }

    if (Date.now() >= deadline) {
      for (const job of parsed.jobs) {
        const result = results.get(job.id)!;
        if (result.status !== 'pending') continue;
        result.status = 'blocked';
        result.blockedBy = ['graph_timeout'];
        result.completedAt = new Date().toISOString();
        result.durationMs = 0;
        changed = true;
      }
    }

    if (changed) await persistGraph();

    for (const job of parsed.jobs) {
      if (running.size >= parsed.max_parallel) break;
      const result = results.get(job.id)!;
      if (result.status !== 'pending') continue;

      const ready = job.depends_on.every(
        (dependency) =>
          results.get(dependency)?.status === 'succeeded',
      );
      if (!ready) continue;

      startJob(job);
      changed = true;
    }

    const unfinished = [...results.values()].some(
      (result) =>
        result.status === 'pending' || result.status === 'running',
    );
    if (!unfinished) break;

    if (running.size === 0) {
      if (!changed) {
        throw new Error(
          'Task graph could not make progress despite passing validation.',
        );
      }
      continue;
    }

    await Promise.race(running.values());
  }

  const ordered = parsed.jobs.map((job) => results.get(job.id)!);
  const succeeded = ordered.filter(
    (result) => result.status === 'succeeded',
  ).length;
  const failed = ordered.filter(
    (result) => result.status === 'failed',
  ).length;
  const blocked = ordered.filter(
    (result) => result.status === 'blocked',
  ).length;
  const unknown = ordered.filter(
    (result) => result.status === 'unknown',
  ).length;

  await persistGraph(
    unknown > 0
      ? 'interrupted'
      : failed > 0
        ? 'failed'
        : blocked > 0
          ? 'blocked'
          : 'succeeded',
  );

  return {
    data: {
      ...(parsed.graph_id ? { graphId: parsed.graph_id, specHash } : {}),
      resumed: parsed.resume,
      ok: failed === 0 && blocked === 0 && unknown === 0,
      maxParallel: parsed.max_parallel,
      stopOnFailure: parsed.stop_on_failure,
      totalTimeoutMs: parsed.total_timeout_ms,
      durationMs: Date.now() - startedAt,
      summary: {
        total: ordered.length,
        succeeded,
        failed,
        blocked,
        ...(unknown > 0 ? { unknown } : {}),
      },
      results: ordered,
    },
  };
}

async function workspaceSnapshot(
  input: unknown,
  policy: PathPolicy,
): Promise<unknown> {
  const parsed = WorkspaceSnapshotInputSchema.parse(input);
  const cwd = await policy.resolveExisting(parsed.path);
  const [rootResult, statusResult, headResult, logResult] = await Promise.all([
    runProcess('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeoutMs: 10_000,
    }),
    runProcess('git', ['-C', cwd, 'status', '--short', '--branch'], {
      timeoutMs: 10_000,
    }),
    runProcess('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: 10_000,
    }),
    runProcess('git', ['-C', cwd, 'log', '-1', '--format=%H%x09%s'], {
      timeoutMs: 10_000,
    }),
  ]);

  if (rootResult.exitCode !== 0) {
    throw new Error(rootResult.stderr.trim() || 'Not a Git workspace.');
  }

  const markerNames = [
    'package.json',
    'Cargo.toml',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
  ];
  const root = rootResult.stdout.trim();
  const rootEntries = await fs.readdir(root, { withFileTypes: true });
  const projectMarkers = markerNames.filter((marker) =>
    rootEntries.some((entry) => entry.isFile() && entry.name === marker),
  );
  projectMarkers.push(
    ...rootEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sln'))
      .map((entry) => entry.name),
  );

  return {
    data: {
      requestedPath: cwd,
      root,
      branch: headResult.stdout.trim(),
      status: statusResult.stdout.trimEnd(),
      lastCommit: logResult.stdout.trim(),
      projectMarkers,
    },
  };
}

export interface AgentExecutionContext {
  processes?: ProcessManager;
  taskGraphs?: TaskGraphStore;
  artifacts?: ArtifactStore;
}

function requireProcesses(context: AgentExecutionContext): ProcessManager {
  if (!context.processes) throw new Error('Process manager is unavailable.');
  return context.processes;
}

function requireTaskGraphs(context: AgentExecutionContext): TaskGraphStore {
  if (!context.taskGraphs) {
    throw new Error('Persistent task graph store is unavailable.');
  }
  return context.taskGraphs;
}

function requireArtifacts(context: AgentExecutionContext): ArtifactStore {
  if (!context.artifacts) {
    throw new Error('Persistent artifact store is unavailable.');
  }
  return context.artifacts;
}


export async function executeCapability(
  capability: Capability,
  input: unknown,
  policy: PathPolicy,
  context: AgentExecutionContext = {},
): Promise<unknown> {
  switch (capability) {
    case 'shell.exec':
      return await executeShell(input, policy);
    case 'process.start':
      return { data: await requireProcesses(context).start(input, policy) };
    case 'process.read':
      return { data: await requireProcesses(context).read(input) };
    case 'process.write':
      return { data: await requireProcesses(context).write(input) };
    case 'process.stop':
      return { data: await requireProcesses(context).stop(input) };
    case 'process.list':
      return { data: requireProcesses(context).list() };
    case 'process.prune':
      return { data: await requireProcesses(context).prune(input) };
    case 'wsl.exec':
      return await executeWsl(input);
    case 'files.read':
      return await readFile(input, policy);
    case 'files.read_many':
      return await readManyFiles(input, policy);
    case 'files.write':
      return await writeFile(input, policy);
    case 'files.stat':
      return await statPath(input, policy);
    case 'files.hash':
      return await hashFile(input, policy);
    case 'files.mkdir':
      return await makeDirectory(input, policy);
    case 'files.copy':
      return await copyPath(input, policy);
    case 'files.move':
      return await movePath(input, policy);
    case 'files.delete':
      return await deletePath(input, policy);
    case 'files.patch':
      return await patchFile(input, policy);
    case 'files.list':
      return await listDirectory(input, policy);
    case 'search.text':
      return await searchText(input, policy);
    case 'machine.snapshot':
      return await machineSnapshot(policy);
    case 'machine.health':
    case 'network.dns.resolve':
    case 'network.tcp.probe':
    case 'network.http.probe':
      return await executeSystemCapability(capability, input);
    case 'workspace.snapshot':
      return await workspaceSnapshot(input, policy);
    case 'workspace.detect':
      return await workspaceDetect(input, policy);
    case 'workspace.checks':
      return await workspaceChecks(input, policy);
    case 'task.graph.run':
      return await runTaskGraph(input, policy, context.taskGraphs);
    case 'task.graph.list':
      return { data: requireTaskGraphs(context).list() };
    case 'task.graph.get': {
      const parsed = TaskGraphGetInputSchema.parse(input);
      return { data: requireTaskGraphs(context).get(parsed.graph_id) };
    }
    case 'task.graph.prune': {
      const parsed = TaskGraphPruneInputSchema.parse(input);
      return {
        data: await requireTaskGraphs(context).prune({
          ...(parsed.older_than_ms !== undefined
            ? { olderThanMs: parsed.older_than_ms }
            : {}),
        }),
      };
    }
    case 'artifact.register': {
      const parsed = ArtifactRegisterInputSchema.parse(input);
      return {
        data: await requireArtifacts(context).register(
          {
            path: parsed.path,
            ...(parsed.label ? { label: parsed.label } : {}),
            kind: parsed.kind,
            ...(parsed.source_graph_id
              ? { sourceGraphId: parsed.source_graph_id }
              : {}),
            ...(parsed.source_job_id
              ? { sourceJobId: parsed.source_job_id }
              : {}),
            maxHashBytes: parsed.max_hash_bytes,
          },
          policy,
        ),
      };
    }
    case 'artifact.list': {
      const parsed = ArtifactListInputSchema.parse(input);
      return {
        data: await requireArtifacts(context).list({
          ...(parsed.graph_id ? { graphId: parsed.graph_id } : {}),
          ...(parsed.job_id ? { jobId: parsed.job_id } : {}),
          ...(parsed.kind ? { kind: parsed.kind } : {}),
          limit: parsed.limit,
        }),
      };
    }
    case 'artifact.get': {
      const parsed = ArtifactGetInputSchema.parse(input);
      return {
        data: await requireArtifacts(context).get(parsed.artifact_id),
      };
    }
    case 'artifact.verify': {
      const parsed = ArtifactVerifyInputSchema.parse(input);
      return {
        data: await requireArtifacts(context).verify(
          parsed.artifact_id,
          policy,
          parsed.max_hash_bytes,
        ),
      };
    }
    case 'artifact.prune': {
      const parsed = ArtifactPruneInputSchema.parse(input);
      return {
        data: await requireArtifacts(context).prune({
          ...(parsed.older_than_ms !== undefined
            ? { olderThanMs: parsed.older_than_ms }
            : {}),
          removeMissing: parsed.remove_missing,
          policy,
        }),
      };
    }
    case 'windows.processes':
    case 'windows.services':
    case 'windows.network.snapshot':
    case 'windows.service.control':
    case 'windows.registry.read':
    case 'windows.tasks':
    case 'windows.eventlog.query':
    case 'windows.firewall.rules':
    case 'windows.registry.set':
    case 'windows.registry.delete':
    case 'windows.task.control':
    case 'windows.firewall.control':
      return await executeWindowsCapability(capability, input);
    case 'windows.environment.list':
    case 'windows.environment.read':
    case 'windows.environment.set':
    case 'windows.environment.delete':
      return await executeWindowsEnvironmentCapability(capability, input);
    case 'windows.window.list':
    case 'windows.window.focus':
      return await executeWindowsWindowCapability(capability, input);
    case 'windows.screenshot':
      return await captureWindowsScreenshot(input);
    case 'windows.clipboard.read':
    case 'windows.clipboard.write':
    case 'windows.clipboard.clear':
    case 'windows.keyboard.type':
    case 'windows.keyboard.hotkey':
      return await executeWindowsInputCapability(capability, input);
    case 'windows.accessibility.tree':
    case 'windows.accessibility.find':
    case 'windows.accessibility.invoke':
    case 'windows.accessibility.set_value':
      return await executeWindowsAccessibilityCapability(capability, input);
    case 'windows.pointer.position':
    case 'windows.pointer.move':
    case 'windows.pointer.click':
    case 'windows.pointer.scroll':
      return await executeWindowsPointerCapability(capability, input);
    case 'browser.session.start':
    case 'browser.session.list':
    case 'browser.session.stop':
    case 'browser.tabs':
    case 'browser.navigate':
    case 'browser.snapshot':
    case 'browser.click':
    case 'browser.set_value':
    case 'browser.screenshot':
    case 'browser.visual.verify':
      return await executeBrowserCapability(capability, input);
    default:
      throw new Error(`Unsupported capability: ${capability}`);
  }
}

export function normalizeAgentError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof z.ZodError) {
    return {
      code: 'INVALID_INPUT',
      message: 'Capability input failed validation.',
      details: error.issues,
    };
  }
  if (error instanceof PathDeniedError) {
    return {
      code: 'PATH_DENIED',
      message: error.message,
      details: { path: error.requestedPath },
    };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String(error),
      ...('details' in error ? { details: error.details } : {}),
    };
  }
  return {
    code: 'EXECUTION_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
