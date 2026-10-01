import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolvePackageJson(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '..', 'package.json'),
    path.resolve(moduleDir, '..', '..', 'package.json'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error('Unable to locate Nexowire package.json for version metadata.');
  }
  return found;
}

function readVersion(): string {
  const decoded = JSON.parse(
    readFileSync(resolvePackageJson(), 'utf8'),
  ) as { version?: unknown };
  if (typeof decoded.version !== 'string' || decoded.version.length === 0) {
    throw new Error('Nexowire package.json has no valid version.');
  }
  return decoded.version;
}

export const NEXOWIRE_VERSION = readVersion();
