import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Apply a private Windows ProgramData DACL without recursively stripping
 * inherited ACEs from children. An icacls /inheritance:r /T combination
 * can leave existing child files with no access entries at all.
 */
export function windowsProgramDataAclArguments(
  target: string,
  directory: boolean,
): string[] {
  const permission = directory ? '(OI)(CI)F' : 'F';
  return [
    target,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:' + permission,
    '*S-1-5-32-544:' + permission,
    '/remove:g',
    '*S-1-5-32-545',
  ];
}

function applyAcl(target: string, directory: boolean): void {
  const result = spawnSync(
    'icacls.exe',
    windowsProgramDataAclArguments(target, directory),
    {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
      result.stdout.trim() ||
      'Failed to harden Windows ProgramData ACL: ' + target,
    );
  }
}

export function hardenWindowsProgramDataAcl(
  root: string,
): void {
  if (process.platform !== 'win32') return;

  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      'Refusing to harden non-directory or reparse-point ProgramData root.',
    );
  }

  // These protected lifecycle directories contain only flat files.
  // Fail closed instead of traversing a junction or unexpected subdirectory.
  const entries = readdirSync(root, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        'Unexpected object in protected ProgramData directory: ' +
          entry.name,
      );
    }
  }

  applyAcl(root, true);
  for (const entry of entries) {
    applyAcl(path.join(root, entry.name), false);
  }
}
