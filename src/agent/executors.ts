import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import type { Capability } from '../protocol/capabilities.js';
import { PathPolicy, PathDeniedError } from './path-policy.js';
import { executeWindowsCapability } from './windows-control.js';
import type { ProcessManager } from './process-manager.js';

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
});

const FileReadManyInputSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  max_bytes_each: z.number().int().min(1).max(16_777_216).default(2_097_152),
  max_total_bytes: z.number().int().min(1024).max(67_108_864).default(16_777_216),
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
});

const FileListInputSchema = z.object({
  path: z.string().min(1).max(4096),
  depth: z.number().int().min(1).max(5).default(2),
  max_entries: z.number().int().min(1).max(5000).default(1000),
});

const WorkspaceSnapshotInputSchema = z.object({
  path: z.string().min(1).max(4096),
});

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
        content: parsed.encoding === 'base64' ? content.toString('base64') : content.toString('utf8'),
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
  if (stat.size > parsed.max_bytes) throw new Error(`Patch target exceeds max_bytes ${parsed.max_bytes}.`);
  let content = await fs.readFile(target, 'utf8');

  const applied: Array<{ index: number; replacements: number }> = [];
  for (let index = 0; index < parsed.operations.length; index++) {
    const operation = parsed.operations[index]!;
    const count = countOccurrences(content, operation.old_text);
    if (count !== operation.expected_count) {
      throw new Error(
        `Patch operation ${index + 1} expected ${operation.expected_count} occurrence(s), found ${count}.`,
      );
    }
    content = content.split(operation.old_text).join(operation.new_text);
    applied.push({ index, replacements: count });
  }

  const temp = `${target}.nexowire-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, content, 'utf8');
    await fs.chmod(temp, stat.mode);
    if (process.platform === 'win32') {
      await fs.copyFile(temp, target);
      await fs.rm(temp, { force: true });
    } else {
      await fs.rename(temp, target);
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  return { data: { path: target, applied, bytes: Buffer.byteLength(content) } };
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
}

function requireProcesses(context: AgentExecutionContext): ProcessManager {
  if (!context.processes) throw new Error('Process manager is unavailable.');
  return context.processes;
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
    case 'workspace.snapshot':
      return await workspaceSnapshot(input, policy);
    case 'windows.processes':
    case 'windows.services':
    case 'windows.network.snapshot':
    case 'windows.service.control':
    case 'windows.registry.read':
    case 'windows.tasks':
    case 'windows.eventlog.query':
    case 'windows.firewall.rules':
      return await executeWindowsCapability(capability, input);
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
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    code: 'EXECUTION_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
