import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class PathDeniedError extends Error {
  constructor(public readonly requestedPath: string) {
    super(`Path is outside the agent allowlist: ${requestedPath}`);
    this.name = 'PathDeniedError';
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

export class PathPolicy {
  constructor(private readonly roots: readonly string[]) {}

  resolve(requestedPath: string, cwd = process.cwd()): string {
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
    const resolved = this.resolve(requestedPath, cwd);
    if (this.roots.includes('*')) return await fs.realpath(resolved);

    const [realTarget, realRoots] = await Promise.all([
      fs.realpath(resolved),
      Promise.all(this.roots.map((root) => fs.realpath(path.resolve(root)))),
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
    const resolved = this.resolve(requestedPath, cwd);
    if (this.roots.includes('*')) return resolved;

    const realRoots = await Promise.all(
      this.roots.map((root) => fs.realpath(path.resolve(root))),
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
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'ENOENT'
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

  describe(): string[] {
    return [...this.roots];
  }

  private isWithinAnyRoot(
    candidate: string,
    roots: readonly string[],
  ): boolean {
    return roots.some((root) => {
      const relative = path.relative(root, candidate);
      return (
        relative === '' ||
        (!relative.startsWith('..' + path.sep) &&
          relative !== '..' &&
          !path.isAbsolute(relative))
      );
    });
  }
}
