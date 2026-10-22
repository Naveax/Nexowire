import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRemovableVolume,
  mapVolumeGrantRoot,
  resolveWindowsVolumeIdentity,
  ScopedPathGrantRegistry,
  unsafeWindowsPath,
  withinRoot,
  type FileScope,
  type VolumeIdentity,
  type VolumeResolver,
} from './scoped-path-grants.js';

export class PathDeniedError extends Error {
  readonly code = 'PATH_DENIED';
  readonly details: {
    reason: string;
    scope?: FileScope;
    requiredPermission: string;
    nextStep: string;
  };

  constructor(
    public readonly requestedPath: string,
    reason = 'PATH_OUTSIDE_ALLOWED_ROOTS',
    scope?: FileScope,
  ) {
    super(`Path access denied (${reason}): ${requestedPath}`);
    this.name = 'PathDeniedError';
    this.details = {
      reason,
      ...(scope ? { scope } : {}),
      requiredPermission: scope ?? 'allowedRoots',
      nextStep: reason === 'USB_VOLUME_GRANT_REQUIRED'
        ? 'Approve a short-lived grant for the verified USB volume and exact target on the physical device.'
        : reason === 'UNSANDBOXED_EXECUTION_DENIED'
          ? 'Use scoped file tools, or explicitly authorize an unrestricted execution session on the physical device.'
          : reason === 'TASK_OS_SANDBOX_MUTATION_UNAVAILABLE'
            ? 'Task file mutations require a separately verified OS sandbox and atomic native handle-relative filesystem executor; path checks and external grants are insufficient.'
          : reason === 'WINDOWS_NATIVE_HANDLE_GUARD_REQUIRED'
            ? 'No verified atomic native Windows handle-based mutation executor is connected. Do not mutate this target until that native security gate is independently accepted.'
          : 'Choose a verified allowed root or request an owner-approved, target-scoped permission.',
    };
  }
}

export function parseAllowedRoots(
  value: string | undefined,
  home = os.homedir(),
): string[] {
  const raw = value?.trim();
  if (!raw) return [path.resolve(home)];
  if (raw === '*') return ['*'];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

export interface PathPolicyOptions {
  grants?: ScopedPathGrantRegistry;
  ownerId?: string;
  deviceId?: string;
  volumeResolver?: VolumeResolver;
  platform?: NodeJS.Platform;
  defaultScopes?: readonly FileScope[];
  // Trusted local task-worktree scope, never loaded from a remote tool payload.
  // This is PATH POLICY ONLY, not a kernel/child-process sandbox. Until an
  // independently verified OS handle-relative executor exists, mutations and
  // unrestricted child execution are denied in task mode on every platform.
  taskRoot?: string;
  // The native Agent supplies a grant registry and is always strict.
  // Legacy library-only PathPolicy instances retain existing test semantics.
  enforceExecutionBoundary?: boolean;
  // Only the trusted Native Agent may set this. When true, refuse mutations
  // that depend on a scoped grant or removable volume until Windows native
  // handle-relative filesystem I/O can pin target and volume atomically.
  enforceWindowsNativeHandleBoundary?: boolean;
  // Local-only explicit override. Never accept this through remote tool input.
  unrestrictedExecutionUntil?: number;
  now?: () => number;
}

const LEGACY_ROOT_SCOPES: readonly FileScope[] = [
  'read', 'write', 'delete', 'move', 'recursive_delete',
];
const MUTATIONS = new Set<FileScope>([
  'write', 'delete', 'move', 'recursive_delete', 'usb_write',
]);

export class PathPolicy {
  private readonly platform: NodeJS.Platform;
  private readonly volumeResolver: VolumeResolver;
  private readonly now: () => number;
  private readonly defaultScopes: readonly FileScope[];
  private readonly taskRoot: string | undefined;
  private readonly approvedExecutionUntil: number | undefined;

  constructor(
    private readonly roots: readonly string[],
    private readonly options: PathPolicyOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.volumeResolver = options.volumeResolver ?? resolveWindowsVolumeIdentity;
    this.now = options.now ?? Date.now;
    this.defaultScopes = options.defaultScopes ?? LEGACY_ROOT_SCOPES;
    if (options.taskRoot !== undefined) {
      const taskRoot = options.taskRoot;
      if (typeof taskRoot !== 'string' || !path.isAbsolute(taskRoot) ||
          (this.platform === 'win32' && unsafeWindowsPath(taskRoot)) ||
          path.resolve(taskRoot) === path.parse(taskRoot).root) {
        throw new PathDeniedError(String(taskRoot), 'TASK_ROOT_INVALID');
      }
      this.taskRoot = path.resolve(taskRoot);
    }
    const remaining = (options.unrestrictedExecutionUntil ?? 0) - this.now();
    this.approvedExecutionUntil = remaining > 0 && remaining <= 15 * 60_000
      ? options.unrestrictedExecutionUntil : undefined;
  }

  private assertSafeSyntax(requested: string): void {
    if (this.platform !== 'win32') return;
    const reason = unsafeWindowsPath(requested);
    if (reason) throw new PathDeniedError(requested, reason);
  }

  private defaultRoots(): readonly string[] {
    // A task root always narrows even an inherited wildcard/home allowlist.
    return this.taskRoot ? [this.taskRoot] : this.roots;
  }

  private async assertTaskRootNotReparse(): Promise<{dev: bigint; ino: bigint} | undefined> {
    if (!this.taskRoot) return undefined;
    // Reject a symlink/junction passed as the task root itself. This check
    // still cannot protect ancestor changes after observation; only an OS
    // retained-directory-handle sandbox could guarantee that property.
    let st: import('node:fs').BigIntStats;
    try { st = await fs.lstat(this.taskRoot, {bigint:true}); }
    catch { throw new PathDeniedError(this.taskRoot, 'TASK_ROOT_UNVERIFIED'); }
    if (!st.isDirectory() || st.isSymbolicLink() || st.ino <= 0n) {
      throw new PathDeniedError(this.taskRoot, 'TASK_ROOT_REPARSE_UNVERIFIED');
    }
    return {dev:st.dev,ino:st.ino};
  }

  private async assertTaskRootIdentityStable(
    original: {dev:bigint;ino:bigint} | undefined, scope:FileScope,
  ):Promise<void> {
    if (!original || !this.taskRoot) return;
    let after:{dev:bigint;ino:bigint}|undefined;
    try { after=await this.assertTaskRootNotReparse(); }
    catch {
      throw new PathDeniedError(this.taskRoot,'TASK_ROOT_CHANGED_DURING_AUTHORIZATION',scope);
    }
    if (!after || after.dev!==original.dev || after.ino!==original.ino) {
      throw new PathDeniedError(this.taskRoot,'TASK_ROOT_CHANGED_DURING_AUTHORIZATION',scope);
    }
    // A post-check rename still requires a native retained-directory-handle
    // File API. This resampling is not a complete kernel sandbox or lock.
  }

  resolve(requestedPath: string, cwd = process.cwd()): string {
    this.assertSafeSyntax(requestedPath);
    const resolved = path.resolve(cwd, requestedPath);
    const roots = this.defaultRoots();
    if (roots.includes('*')) return resolved;
    if (!this.isWithinAnyRoot(resolved, roots.map((root) => path.resolve(root)))) {
      throw new PathDeniedError(resolved);
    }
    return resolved;
  }

  async resolveExisting(
    requestedPath: string,
    cwd = process.cwd(),
  ): Promise<string> {
    await this.assertTaskRootNotReparse();
    return this.resolveExistingWithRoots(requestedPath, cwd, this.defaultRoots());
  }

  private async resolveExistingWithRoots(
    requestedPath: string,
    cwd: string,
    roots: readonly string[],
  ): Promise<string> {
    this.assertSafeSyntax(requestedPath);
    const resolved = path.resolve(cwd, requestedPath);
    if (roots.includes('*')) return await fs.realpath(resolved);
    const [realTarget, realRoots] = await Promise.all([
      fs.realpath(resolved),
      Promise.all(roots.map((root) => fs.realpath(path.resolve(root)))),
    ]);
    if (!this.isWithinAnyRoot(realTarget, realRoots)) {
      throw new PathDeniedError(resolved);
    }
    return realTarget;
  }

  async resolveForCreate(
    requestedPath: string,
    cwd = process.cwd(),
  ): Promise<string> {
    await this.assertTaskRootNotReparse();
    return this.resolveForCreateWithRoots(requestedPath, cwd, this.defaultRoots());
  }

  private async resolveForCreateWithRoots(
    requestedPath: string,
    cwd: string,
    roots: readonly string[],
  ): Promise<string> {
    this.assertSafeSyntax(requestedPath);
    const resolved = path.resolve(cwd, requestedPath);
    // Even wildcard roots must canonicalize existing ancestors: otherwise
    // a link on C: pointing to a removable E: volume is misidentified as C:.
    const unrestricted = roots.includes('*');
    const realRoots = unrestricted ? [] : await Promise.all(
      roots.map((root) => fs.realpath(path.resolve(root))),
    );
    let cursor = resolved;
    const suffix: string[] = [];
    while (true) {
      try {
        const realAncestor = await fs.realpath(cursor);
        if (!unrestricted && !this.isWithinAnyRoot(realAncestor, realRoots)) {
          throw new PathDeniedError(resolved);
        }
        return path.join(realAncestor, ...suffix.reverse());
      } catch (error) {
        if (
          typeof error !== 'object' || error === null ||
          !('code' in error) || error.code !== 'ENOENT'
        ) {
          throw error;
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new PathDeniedError(resolved);
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }

  private availableRoots(requestedPath: string, cwd: string): readonly string[] {
    const candidate = path.resolve(cwd, requestedPath);
    return [
      ...this.defaultRoots(),
      ...(this.options.grants && this.options.ownerId && this.options.deviceId
        ? this.options.grants.active(this.options.ownerId, this.options.deviceId)
          .map(grant => mapVolumeGrantRoot(grant, candidate))
        : []),
    ];
  }

  async authorizeExisting(
    requestedPath: string,
    scope: FileScope,
    cwd = process.cwd(),
  ): Promise<string> {
    const taskRootId = await this.assertTaskRootNotReparse();
    const roots = this.availableRoots(requestedPath, cwd);
    const target = await this.resolveExistingWithRoots(requestedPath, cwd, roots);
    await this.assertScope(target, scope);
    await this.assertPathStable(requestedPath, target, cwd, roots, scope, true);
    await this.assertTaskRootIdentityStable(taskRootId,scope);
    return target;
  }

  async authorizeForCreate(
    requestedPath: string,
    scope: FileScope,
    cwd = process.cwd(),
  ): Promise<string> {
    const taskRootId = await this.assertTaskRootNotReparse();
    const roots = this.availableRoots(requestedPath, cwd);
    const target = await this.resolveForCreateWithRoots(requestedPath, cwd, roots);
    await this.assertScope(target, scope);
    await this.assertPathStable(requestedPath, target, cwd, roots, scope, false);
    await this.assertTaskRootIdentityStable(taskRootId,scope);
    return target;
  }

  private async assertPathStable(
    requestedPath: string,
    expected: string,
    cwd: string,
    roots: readonly string[],
    scope: FileScope,
    existing: boolean,
  ): Promise<void> {
    // In particular, the volume resolver may await an external process while a
    // directory is replaced by a junction. Check the ORIGINAL caller path
    // again after scope/volume approval, not only its prior canonical form.
    // This reduces a deterministic race window; it is NOT an atomic Windows
    // handle-relative check or a guarantee against later replacement.
    let current: string;
    try {
      current = existing
        ? await this.resolveExistingWithRoots(requestedPath, cwd, roots)
        : await this.resolveForCreateWithRoots(requestedPath, cwd, roots);
    } catch {
      throw new PathDeniedError(requestedPath, 'PATH_CHANGED_DURING_AUTHORIZATION', scope);
    }
    const normalize = (s: string) => this.platform === 'win32' ? s.toLowerCase() : s;
    if (normalize(current) !== normalize(expected)) {
      throw new PathDeniedError(requestedPath, 'PATH_CHANGED_DURING_AUTHORIZATION', scope);
    }
  }

  private async assertScope(target: string, scope: FileScope): Promise<void> {
    if (MUTATIONS.has(scope) && this.isVolumeRoot(target)) {
      throw new PathDeniedError(target, 'VOLUME_ROOT_MUTATION_DENIED', scope);
    }
    const roots = this.defaultRoots();
    const rootAllowed = roots.includes('*') ||
      await this.withinRealRoots(target, roots);
    const defaultAllowed = rootAllowed && this.defaultScopes.includes(scope);
    const activeGrants = this.options.grants && this.options.ownerId &&
      this.options.deviceId
      ? this.options.grants.active(this.options.ownerId, this.options.deviceId)
      : [];
    const candidateGrant = activeGrants.some(grant =>
      grant.scopes.includes(scope) &&
      withinRoot(target, mapVolumeGrantRoot(grant, target)));
    // A denied scope must not spawn an expensive disk identity lookup.
    if (!defaultAllowed && !candidateGrant) {
      throw new PathDeniedError(target, 'SCOPE_NOT_GRANTED', scope);
    }
    // No OS task sandbox / native parent-handle-relative mutation writer is
    // currently connected. A pathname-only task root cannot secure creates,
    // renames, deletes or writes against a post-check junction/volume race.
    // Keep task mutation DENIED even if an external local grant exists.
    if (this.taskRoot && MUTATIONS.has(scope)) {
      throw new PathDeniedError(target, 'TASK_OS_SANDBOX_MUTATION_UNAVAILABLE', scope);
    }
    let volume: VolumeIdentity | null = null;
    if (this.platform === 'win32' && MUTATIONS.has(scope)) {
      try {
        volume = await this.volumeResolver(target);
      } catch {
        throw new PathDeniedError(target, 'VOLUME_IDENTITY_UNAVAILABLE', scope);
      }
      if (!volume) {
        throw new PathDeniedError(target, 'VOLUME_IDENTITY_UNAVAILABLE', scope);
      }
    }
    const grantAllowed = Boolean(
      this.options.grants && this.options.ownerId && this.options.deviceId &&
      this.options.grants.authorizes(
        target, scope, this.options.ownerId, this.options.deviceId, volume,
      ),
    );
    if (!defaultAllowed && !grantAllowed) {
      throw new PathDeniedError(target, 'VOLUME_GRANT_MISMATCH', scope);
    }
    // A trusted owner-issued exception is not a substitute for an atomic
    // handle-relative Windows filesystem operation. Do not enable mutation
    // outside normal roots just because pathname checks passed.
    if (this.options.enforceWindowsNativeHandleBoundary &&
        this.platform === 'win32' && MUTATIONS.has(scope) &&
        !defaultAllowed && grantAllowed &&
        (!volume || !isRemovableVolume(volume))) {
      throw new PathDeniedError(target, 'WINDOWS_NATIVE_HANDLE_GUARD_REQUIRED', scope);
    }
    if (volume && isRemovableVolume(volume) && MUTATIONS.has(scope)) {
      if (!this.options.grants || !this.options.ownerId ||
          !this.options.deviceId ||
          !this.options.grants.authorizes(
            target, 'usb_write', this.options.ownerId, this.options.deviceId, volume,
          )) {
        throw new PathDeniedError(target, 'USB_VOLUME_GRANT_REQUIRED', 'usb_write');
      }
      // Local physical Agent policy does not currently expose an atomic,
      // authenticated Win32 handle-relative mutation executor. A consent grant
      // alone is not a safe reparse/hotplug barrier. Keep REAL USB mutations
      // unavailable until an independently verified native helper is wired.
      // Injected resolvers in temporary synthetic tests are not a live device.
      if (this.platform === 'win32' &&
          this.options.enforceWindowsNativeHandleBoundary) {
        throw new PathDeniedError(target, 'WINDOWS_NATIVE_HANDLE_GUARD_REQUIRED', scope);
      }
    }
  }

  private async withinRealRoots(
    target: string,
    roots: readonly string[],
  ): Promise<boolean> {
    for (const root of roots) {
      try {
        if (withinRoot(target, await fs.realpath(path.resolve(root))))
          return true;
      } catch {
        // A missing root cannot silently broaden permissions.
      }
    }
    return false;
  }

  private isVolumeRoot(target: string): boolean {
    return path.parse(target).root === target;
  }

  assertUnrestrictedExecution(): void {
    if (this.taskRoot) {
      throw new PathDeniedError('<task child process>', 'UNSANDBOXED_EXECUTION_DENIED');
    }
    if (this.platform === 'win32' && this.options.enforceWindowsNativeHandleBoundary) {
      // A startup environment lease cannot sandbox arbitrary Windows processes.
      // Any shell/WSL/process may mutate USB files outside scoped file tools,
      // so fail closed even for a previously accepted unrestricted lease until
      // an independent native OS security boundary is available.
      throw new PathDeniedError('<unrestricted process>', 'UNSANDBOXED_EXECUTION_DENIED');
    }
    if (!(this.options.enforceExecutionBoundary ?? Boolean(this.options.grants))) return;
    // Arbitrary shells, WSL, task graphs and child processes are not file
    // sandboxes. Refuse to promise path confinement with only command parsing.
    // Even '*' does not authorize USB writes through an unrestricted shell.
    if (this.approvedExecutionUntil && this.approvedExecutionUntil > this.now()) return;
    throw new PathDeniedError(
      '<unrestricted process>', 'UNSANDBOXED_EXECUTION_DENIED',
    );
  }

  describe(): string[] {
    return [...this.roots];
  }

  private isWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
    return roots.some(root => withinRoot(candidate, root));
  }
}
