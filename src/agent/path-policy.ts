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
  private readonly approvedExecutionUntil: number | undefined;

  constructor(
    private readonly roots: readonly string[],
    private readonly options: PathPolicyOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.volumeResolver = options.volumeResolver ?? resolveWindowsVolumeIdentity;
    this.now = options.now ?? Date.now;
    this.defaultScopes = options.defaultScopes ?? LEGACY_ROOT_SCOPES;
    const remaining = (options.unrestrictedExecutionUntil ?? 0) - this.now();
    this.approvedExecutionUntil = remaining > 0 && remaining <= 15 * 60_000
      ? options.unrestrictedExecutionUntil : undefined;
  }

  private assertSafeSyntax(requested: string): void {
    if (this.platform !== 'win32') return;
    const reason = unsafeWindowsPath(requested);
    if (reason) throw new PathDeniedError(requested, reason);
  }

  resolve(requestedPath: string, cwd = process.cwd()): string {
    this.assertSafeSyntax(requestedPath);
    const resolved = path.resolve(cwd, requestedPath);
    if (this.roots.includes('*')) return resolved;
    if (!this.isWithinAnyRoot(resolved, this.roots.map((root) => path.resolve(root)))) {
      throw new PathDeniedError(resolved);
    }
    return resolved;
  }

  async resolveExisting(
    requestedPath: string,
    cwd = process.cwd(),
  ): Promise<string> {
    return this.resolveExistingWithRoots(requestedPath, cwd, this.roots);
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
    return this.resolveForCreateWithRoots(requestedPath, cwd, this.roots);
  }

  private async resolveForCreateWithRoots(
    requestedPath: string,
    cwd: string,
    roots: readonly string[],
  ): Promise<string> {
    this.assertSafeSyntax(requestedPath);
    const resolved = path.resolve(cwd, requestedPath);
    if (roots.includes('*')) return resolved;
    const realRoots = await Promise.all(
      roots.map((root) => fs.realpath(path.resolve(root))),
    );
    let cursor = resolved;
    const suffix: string[] = [];
    while (true) {
      try {
        const realAncestor = await fs.realpath(cursor);
        if (!this.isWithinAnyRoot(realAncestor, realRoots)) {
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
      ...this.roots,
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
    const target = await this.resolveExistingWithRoots(
      requestedPath, cwd, this.availableRoots(requestedPath, cwd),
    );
    await this.assertScope(target, scope);
    return target;
  }

  async authorizeForCreate(
    requestedPath: string,
    scope: FileScope,
    cwd = process.cwd(),
  ): Promise<string> {
    const target = await this.resolveForCreateWithRoots(
      requestedPath, cwd, this.availableRoots(requestedPath, cwd),
    );
    await this.assertScope(target, scope);
    return target;
  }

  private async assertScope(target: string, scope: FileScope): Promise<void> {
    if (MUTATIONS.has(scope) && this.isVolumeRoot(target)) {
      throw new PathDeniedError(target, 'VOLUME_ROOT_MUTATION_DENIED', scope);
    }
    const rootAllowed = this.roots.includes('*') ||
      await this.withinRealRoots(target, this.roots);
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
    if (volume && isRemovableVolume(volume) && MUTATIONS.has(scope)) {
      if (!this.options.grants || !this.options.ownerId ||
          !this.options.deviceId ||
          !this.options.grants.authorizes(
            target, 'usb_write', this.options.ownerId, this.options.deviceId, volume,
          )) {
        throw new PathDeniedError(target, 'USB_VOLUME_GRANT_REQUIRED', 'usb_write');
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
