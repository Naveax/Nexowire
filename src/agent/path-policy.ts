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

    const allowed = this.roots.some((root) => {
      const relative = path.relative(path.resolve(root), resolved);
      return (
        relative === '' ||
        (!relative.startsWith('..' + path.sep) &&
          relative !== '..' &&
          !path.isAbsolute(relative))
      );
    });

    if (!allowed) throw new PathDeniedError(resolved);
    return resolved;
  }

  describe(): string[] {
    return [...this.roots];
  }
}
