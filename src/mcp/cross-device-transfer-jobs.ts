import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import * as z from 'zod';

// Source/destination interaction must go through existing authorized native
// capabilities. Never expose binary bodies through this public MCP surface.
export interface TransferRemote {
  stat(device: string, file: string): Promise<{ type: string; size: number; modifiedAt?: string }>;
  hash(device: string, file: string, maxBytes: number): Promise<string>;
  read(device: string, file: string, offset: number, size: number): Promise<{
    sourceBytes: number; offsetBytes: number; bytesRead: number; contentBase64: string;
  }>;
  write(device: string, file: string, contentBase64: string, first: boolean,
    offset: number): Promise<number>;
  moveNoOverwrite(device: string, from: string, to: string): Promise<void>;
}
export class TransferJobError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TransferJobError';
  }
}
const fail = (code: string, message: string): never => {
  throw new TransferJobError(code, message);
};
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.enum(['QUEUED', 'RUNNING', 'RECOVERY_REQUIRED', 'FAILED',
  'MUTATION_UNKNOWN', 'CANCEL_REQUESTED', 'CANCELLED', 'PUBLISHING', 'COMPLETED']);
const jobSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), accountId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256), sourceDeviceId: z.string().min(1).max(128),
  targetDeviceId: z.string().min(1).max(128),
  sourcePath: z.string().min(1).max(4096), targetPath: z.string().min(1).max(4096),
  stagePath: z.string().min(1).max(4096),
  bytesTotal: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  bytesConfirmed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: hex, sourceModifiedAt: z.string().optional(),
  state: stateSchema, errorCode: z.string().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type TransferJob = z.infer<typeof jobSchema>;
export interface TransferStart {
  accountId: string; projectId: string; sourceDeviceId: string; sourcePath: string;
  targetDeviceId: string; targetPath: string; expectedSourceSha256?: string;
  resumeTransferId?: string;
}
const MAX_NATIVE_HASH = 268_435_456;
const CHUNK = 65_536;
const isNotFound = (error: unknown) => error instanceof Error &&
  (/\bENOENT\b|NOT_FOUND|PATH_NOT_FOUND/i.test(error.message) ||
   ('code' in error && error.code === 'ENOENT'));


export class CrossDeviceTransferJobs {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly modifications = new Map<string, Promise<void>>();
  constructor(private readonly root: string, private readonly remote: TransferRemote) {}
  private file(id: string): string {
    const uuid = z.string().uuid().parse(id);
    return path.join(this.root, uuid + '.json');
  }
  private leaseFile(id: string): string {
    return this.file(id) + '.worker.lock';
  }
  private metadataLockFile(id: string): string {
    return this.file(id) + '.metadata.lock';
  }
  private async withExclusive<T>(filename: string, fn: () => Promise<T>): Promise<T> {
    let handle: fs.FileHandle | undefined;
    for (let n = 0; n < 60; n++) {
      try { handle = await fs.open(filename, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (!handle) return fail('TRANSFER_LOCK_BUSY', 'Transfer journal owner lock is held.');
    try { return await fn(); }
    finally { await handle.close(); await fs.rm(filename, { force: true }); }
  }
  private async workerLeaseActive(id: string): Promise<boolean> {
    let info: { host: string; pid: number };
    try {
      const value = JSON.parse(await fs.readFile(this.leaseFile(id), 'utf8')) as unknown;
      info = z.object({ host: z.string(), pid: z.number().int().positive() }).parse(value);
    } catch (error) {
      if (isNotFound(error)) return false;
      // An unparseable or other-host lock is never evidence that no worker
      // exists. Caution is safer than deleting/cancelling a remote mutation.
      return true;
    }
    if (info.host !== hostname()) return true;
    try { process.kill(info.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  private async assertWorkerLeaseAvailable(job: TransferJob): Promise<void> {
    const filename = this.leaseFile(job.id);
    let info: { host: string; pid: number };
    try {
      const value = JSON.parse(await fs.readFile(filename, 'utf8')) as unknown;
      info = z.object({ host: z.string(), pid: z.number().int().positive() }).parse(value);
    } catch (error) {
      if (isNotFound(error)) return;
      return fail('TRANSFER_WORKER_LOCK_INVALID', 'Worker lock is corrupt; operator must inspect.');
    }
    if (info.host !== hostname()) {
      return fail('TRANSFER_WORKER_BUSY', 'Other-host worker lock requires operator coordination.');
    }
    let active = true;
    try { process.kill(info.pid, 0); }
    catch (error) { active = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    if (active) return fail('TRANSFER_WORKER_BUSY', 'Owner PID remains alive; no concurrent resume.');
    // Recovery of a dead owner lock is only attempted on EXPLICIT resume.
    // The caller must independently reconcile source and staged content first.
  }
  private async recoverDeadWorkerLease(id: string): Promise<void> {
    const filename = this.leaseFile(id);
    try {
      const value = JSON.parse(await fs.readFile(filename, 'utf8')) as { host: string; pid: number };
      if (value.host !== hostname()) return fail('TRANSFER_WORKER_BUSY', 'Foreign-host owner lock.');
      let active = true;
      try { process.kill(value.pid, 0); }
      catch (error) { active = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (active) return fail('TRANSFER_WORKER_BUSY', 'Owner process is still alive.');
      await fs.rename(filename, filename + '.recovered-' + randomUUID());
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  private public(job: TransferJob) {
    return { id: job.id, state: job.state, bytesTotal: job.bytesTotal,
      bytesConfirmed: job.bytesConfirmed, sha256: job.sha256,
      sourceDeviceId: job.sourceDeviceId, targetDeviceId: job.targetDeviceId,
      sourcePath: job.sourcePath, targetPath: job.targetPath,
      updatedAt: job.updatedAt, ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
  }
  // Serialize all updates from cancellation and background worker within a
  // Hub instance, so an old RUNNING snapshot cannot erase CANCEL_REQUESTED.
  private async update(id: string, edit: (job: TransferJob) => void): Promise<TransferJob> {
    const prior = this.modifications.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>(resolve => { unlock = resolve; });
    this.modifications.set(id, current);
    await prior;
    try {
      return await this.withExclusive(this.metadataLockFile(id), async () => {
        const job = await this.load(id);
        edit(job);
        await this.save(job);
        return job;
      });
    } finally {
      unlock();
      if (this.modifications.get(id) === current) this.modifications.delete(id);
    }
  }
  private async load(id: string): Promise<TransferJob> {
    let raw: string;
    try { raw = await fs.readFile(this.file(id), 'utf8'); }
    catch (error) {
      if (isNotFound(error)) return fail('TRANSFER_NOT_FOUND', 'Transfer ID not found.');
      throw error;
    }
    try { return jobSchema.parse(JSON.parse(raw)); }
    catch { return fail('TRANSFER_STATE_CORRUPT', 'Transfer state was corrupted.'); }
  }
  private async save(job: TransferJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    const file = this.file(job.id);
    const temp = file + '.' + randomUUID() + '.tmp';
    const fd = await fs.open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(job) + '\n'); await fd.sync(); }
    finally { await fd.close(); }
    try {
      // Windows can reject a replace-rename while an independent status()
      // reader briefly holds the destination open without FILE_SHARE_DELETE.
      // The retry is bounded and never mutates the old durable job on failure.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temp, file); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if ((code !== 'EPERM' && code !== 'EACCES') || attempt >= 40) throw error;
          await new Promise(resolve => setTimeout(resolve, 15));
        }
      }
    } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  }
  private assertOwner(job: TransferJob, account: string, source: string, target: string,
    project?: string) {
    if (job.accountId !== account || job.sourceDeviceId !== source ||
        job.targetDeviceId !== target || (project && job.projectId !== project)) {
      fail('TRANSFER_SCOPE_DENIED', 'Transfer belongs to a different owner, project or device.');
    }
  }
  // In-memory test/controlled Hub shutdown barrier: never tear down backing
  // state while a spawned async mutation is still finalizing its journal.
  async waitForIdle(id: string): Promise<void> {
    const pending = this.workers.get(id);
    if (pending) await pending;
  }
  async identity(id: string) {
    const job = await this.load(id);
    return { accountId: job.accountId, sourceDeviceId: job.sourceDeviceId,
      targetDeviceId: job.targetDeviceId, projectId: job.projectId };
  }
  async status(id: string, account: string, source: string, target: string) {
    const job = await this.load(id);
    this.assertOwner(job, account, source, target);
    // A different process may have lost the worker after a restart. It is NOT
    // safe to report RUNNING or replay an unacknowledged remote mutation.
    if (job.state === 'RUNNING' && !this.workers.has(id) &&
        !(await this.workerLeaseActive(id))) {
      return { ...this.public(job), state: 'RECOVERY_REQUIRED' as const };
    }
    return this.public(job);
  }
  async cancel(id: string, account: string, source: string, target: string) {
    const runningElsewhere = this.workers.has(id) || await this.workerLeaseActive(id);
    const job = await this.update(id, record => {
      this.assertOwner(record, account, source, target);
      if (record.state === 'COMPLETED' || record.state === 'PUBLISHING') {
        fail('TRANSFER_FINALIZED', 'Already committed or publishing; cannot cancel.');
      }
      if (record.state !== 'CANCELLED') {
        record.state = runningElsewhere ? 'CANCEL_REQUESTED' : 'CANCELLED';
      }
    });
    // Leave the owned stage in quarantine. Never delete it while remote
    // mutation outcomes are uncertain, or modify an existing destination.
    return this.public(job);
  }
  async start(input: TransferStart) {
    if (input.sourceDeviceId === input.targetDeviceId) {
      return fail('DISTINCT_DEVICES_REQUIRED', 'Select two different authorized devices.');
    }
    if (input.sourcePath === input.targetPath && input.sourceDeviceId === input.targetDeviceId) {
      return fail('SOURCE_DESTINATION_SAME', 'A transfer cannot overwrite its own source.');
    }
    if (input.resumeTransferId) {
      const job = await this.load(input.resumeTransferId);
      this.assertOwner(job, input.accountId, input.sourceDeviceId,
        input.targetDeviceId, input.projectId);
      if (job.sourcePath !== input.sourcePath || job.targetPath !== input.targetPath) {
        return fail('TRANSFER_RESUME_MISMATCH', 'Resume path identity does not match durable job.');
      }
      if (this.workers.has(job.id)) return this.public(job);
      if (job.state === 'COMPLETED' || job.state === 'CANCELLED' ||
          job.state === 'CANCEL_REQUESTED' || job.state === 'PUBLISHING') return this.public(job);
      // Two MCP sessions may point at the same job; never adopt an actively
      // owned worker. A dead owner may be quarantined only on explicit resume.
      await this.assertWorkerLeaseAvailable(job);
      // Reconcile remote stage and source BEFORE allowing any new write.
      await this.reconcile(job);
      await this.recoverDeadWorkerLease(job.id);
      job.state = 'QUEUED';
      delete job.errorCode;
      await this.save(job);
      this.spawn(job.id);
      return this.public(job);
    }
    await fs.mkdir(this.root, { recursive: true });
    const present = await fs.readdir(this.root);
    if (present.length > 10000) fail('TRANSFER_JOB_LIMIT', 'Too many transfer metadata entries.');
    let active = 0;
    for (const name of present.filter(n => /^[\da-f-]{36}\.json$/i.test(n))) {
      const prior = await this.load(name.slice(0, -5));
      if (prior.accountId === input.accountId &&
          ['QUEUED', 'RUNNING', 'RECOVERY_REQUIRED'].includes(prior.state)) active++;
    }
    if (active >= 4) fail('TRANSFER_OWNER_BUSY', 'Owner has four unfinished transfers.');
    const stat = await this.remote.stat(input.sourceDeviceId, input.sourcePath);
    if (stat.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      return fail('TRANSFER_SOURCE_INVALID', 'Source must be an ordinary file with safe integer size.');
    }
    // Current Agent native hash/offset APIs are bounded to 256MiB. Don't
    // advertise a working >256MiB physical transfer before #05 accepts it.
    if (stat.size > MAX_NATIVE_HASH) {
      return fail('NATIVE_OFFSET_UNSUPPORTED',
        'Current Agent API cannot independently hash/read beyond 256MiB; requires #05 signed rollout.');
    }
    const digest = (await this.remote.hash(input.sourceDeviceId,
      input.sourcePath, MAX_NATIVE_HASH)).toLowerCase();
    if (!hex.safeParse(digest).success ||
        (input.expectedSourceSha256 && input.expectedSourceSha256 !== digest)) {
      return fail('TRANSFER_SOURCE_HASH_INVALID', 'Source full SHA-256 preflight failed.');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: TransferJob = jobSchema.parse({
      version: 1, id, accountId: input.accountId, projectId: input.projectId,
      sourceDeviceId: input.sourceDeviceId, targetDeviceId: input.targetDeviceId,
      sourcePath: input.sourcePath, targetPath: input.targetPath,
      stagePath: input.targetPath + '.nexowire-upload-' + id + '.part',
      bytesTotal: stat.size, bytesConfirmed: 0, sha256: digest,
      ...(stat.modifiedAt ? { sourceModifiedAt: stat.modifiedAt } : {}),
      state: 'QUEUED', createdAt: now, updatedAt: now,
    });
    const fd = await fs.open(this.file(id), 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(job) + '\n'); await fd.sync(); }
    finally { await fd.close(); }
    this.spawn(id);
    return this.public(job);
  }
  private spawn(id: string): void {
    if (this.workers.has(id)) return;
    // Work is scoped to this running Hub instance; process restart must
    // explicitly reconcile before any resumption. No unbounded MCP body.
    const running = this.runWithLease(id).catch(async (error: unknown) => {
      if (error instanceof TransferJobError && error.code === 'TRANSFER_WORKER_BUSY') return;
      await this.update(id, job => {
        if (job.state === 'CANCEL_REQUESTED') job.state = 'CANCELLED';
        else {
          job.state = job.state === 'MUTATION_UNKNOWN' ? 'MUTATION_UNKNOWN' : 'FAILED';
          job.errorCode = error instanceof TransferJobError ? error.code :
            'TRANSFER_REMOTE_ERROR';
        }
      });
    }).finally(() => { this.workers.delete(id); });
    this.workers.set(id, running);
  }
  private async runWithLease(id: string): Promise<void> {
    let handle: fs.FileHandle;
    try { handle = await fs.open(this.leaseFile(id), 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('TRANSFER_WORKER_BUSY', 'Another Hub worker owns this transfer.');
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ host: hostname(), pid: process.pid,
        at: new Date().toISOString() }) + '\n');
      await handle.sync();
      await this.run(id);
    } finally {
      await handle.close();
      await fs.rm(this.leaseFile(id), { force: true });
    }
  }
  private async reconcile(job: TransferJob): Promise<void> {
    const stat = await this.remote.stat(job.sourceDeviceId, job.sourcePath);
    if (stat.type !== 'file' || stat.size !== job.bytesTotal ||
        (job.sourceModifiedAt && job.sourceModifiedAt !== stat.modifiedAt) ||
        (await this.remote.hash(job.sourceDeviceId, job.sourcePath, MAX_NATIVE_HASH)).toLowerCase() !== job.sha256) {
      return fail('TRANSFER_SOURCE_CHANGED', 'Original source no longer matches verified identity.');
    }
    let staged: { type: string; size: number };
    try { staged = await this.remote.stat(job.targetDeviceId, job.stagePath); }
    catch (error) {
      if (isNotFound(error) && job.bytesConfirmed === 0) return;
      // Stage missing with positive offset might mean an unknown commit.
      return fail('TRANSFER_STAGE_UNKNOWN', 'Stage disappeared; operator must reconcile destination.');
    }
    if (staged.type !== 'file' || staged.size < job.bytesConfirmed ||
        staged.size > job.bytesTotal) {
      return fail('TRANSFER_STAGE_CHANGED', 'Remote stage length contradicts durable receipts.');
    }
    // Compare source prefix and stage hash, including any bytes written just
    // before an unknown ACK; do not blindly replay remote mutations.
    const prefix = createHash('sha256');
    for (let offset = 0; offset < staged.size; offset += CHUNK) {
      const size = Math.min(CHUNK, staged.size - offset);
      const got = await this.remote.read(job.sourceDeviceId, job.sourcePath, offset, size);
      if (got.sourceBytes !== job.bytesTotal || got.offsetBytes !== offset ||
          got.bytesRead !== size) return fail('TRANSFER_SOURCE_CHANGED', 'Prefix read changed.');
      const bytes = Buffer.from(got.contentBase64, 'base64');
      if (bytes.length !== size || bytes.toString('base64') !== got.contentBase64) {
        return fail('TRANSFER_CHUNK_INVALID', 'Invalid source prefix chunk.');
      }
      prefix.update(bytes);
    }
    const stagedHash = (await this.remote.hash(job.targetDeviceId,
      job.stagePath, MAX_NATIVE_HASH)).toLowerCase();
    if (stagedHash !== prefix.digest('hex')) {
      return fail('TRANSFER_STAGE_CHANGED', 'Remote staged content differs from source prefix.');
    }
    job.bytesConfirmed = staged.size;
    await this.save(job);
  }
  private async run(id: string): Promise<void> {
    let job = await this.update(id, current => {
      current.state = current.state === 'CANCEL_REQUESTED' ||
        current.state === 'CANCELLED' ? 'CANCELLED' : 'RUNNING';
    });
    if (job.state === 'CANCELLED') return;
    let offset = job.bytesConfirmed;
    while (offset < job.bytesTotal || (job.bytesTotal === 0 && offset === 0)) {
      job = await this.load(id);
      if (job.state === 'CANCEL_REQUESTED') {
        await this.update(id, current => { current.state = 'CANCELLED'; });
        return;
      }
      const size = Math.min(CHUNK, job.bytesTotal - offset);
      let content = '';
      if (size > 0) {
        const r = await this.remote.read(job.sourceDeviceId, job.sourcePath, offset, size);
        const same = r.sourceBytes === job.bytesTotal && r.offsetBytes === offset &&
          r.bytesRead === size && typeof r.contentBase64 === 'string';
        if (!same) return fail('TRANSFER_SOURCE_CHANGED', 'Source changed while reading.');
        const bytes = Buffer.from(r.contentBase64, 'base64');
        if (bytes.length !== size || bytes.toString('base64') !== r.contentBase64) {
          return fail('TRANSFER_CHUNK_INVALID', 'Invalid bounded Base64 source read.');
        }
        content = r.contentBase64;
      }
      try {
        if (offset > 0) {
          const remoteStage = await this.remote.stat(job.targetDeviceId, job.stagePath);
          if (remoteStage.type !== 'file' || remoteStage.size !== offset) {
            return fail('TRANSFER_OFFSET_CAS_FAILED',
              'Target staged offset diverged before the next bounded mutation.');
          }
        }
        const wrote = await this.remote.write(job.targetDeviceId,
          job.stagePath, content, offset === 0, offset);
        if (wrote !== size) return fail('TRANSFER_WRITE_SHORT', 'Target wrote unexpected byte count.');
      } catch (error) {
        job.state = 'MUTATION_UNKNOWN';
        job.errorCode = 'TRANSFER_WRITE_OUTCOME_UNKNOWN';
        await this.save(job);
        throw error;
      }
      offset += size;
      const updated = await this.update(id, current => {
        current.bytesConfirmed = offset;
        if (current.state === 'CANCEL_REQUESTED') current.state = 'CANCELLED';
      });
      if (updated.state === 'CANCELLED') return;
      if (job.bytesTotal === 0) break;
    }
    // Verify source AND staged target from Agent, not caller-asserted hashes.
    const final = await this.remote.stat(job.sourceDeviceId, job.sourcePath);
    if (final.type !== 'file' || final.size !== job.bytesTotal ||
        (job.sourceModifiedAt && final.modifiedAt !== job.sourceModifiedAt) ||
        (await this.remote.hash(job.sourceDeviceId, job.sourcePath, MAX_NATIVE_HASH)).toLowerCase() !== job.sha256) {
      return fail('TRANSFER_SOURCE_CHANGED', 'Source changed before publish.');
    }
    if ((await this.remote.hash(job.targetDeviceId, job.stagePath, MAX_NATIVE_HASH)).toLowerCase() !== job.sha256) {
      return fail('TRANSFER_DESTINATION_HASH_MISMATCH', 'Target stage SHA-256 mismatch.');
    }
    const before = await this.update(id, current => {
      current.state = current.state === 'CANCEL_REQUESTED' ? 'CANCELLED' : 'PUBLISHING';
    });
    if (before.state === 'CANCELLED') return;
    try { await this.remote.moveNoOverwrite(job.targetDeviceId, job.stagePath, job.targetPath); }
    catch (error) {
      await this.update(id, current => {
        current.state = 'MUTATION_UNKNOWN'; current.errorCode = 'TRANSFER_PUBLISH_OUTCOME_UNKNOWN';
      });
      throw error;
    }
    await this.update(id, current => {
      current.state = 'COMPLETED'; current.bytesConfirmed = current.bytesTotal;
    });
  }
}
