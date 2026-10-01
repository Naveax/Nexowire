import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReleaseTagCheck {
  checked: boolean;
  refType: string | null;
  refName: string | null;
  packageVersion: string;
  expectedTag: string;
}

export function checkReleaseTag(options: {
  packageVersion: string;
  refType?: string | null;
  refName?: string | null;
}): ReleaseTagCheck {
  const refType = options.refType?.trim() || null;
  const refName = options.refName?.trim() || null;
  const expectedTag = 'v' + options.packageVersion;

  if (refType !== 'tag') {
    return {
      checked: false,
      refType,
      refName,
      packageVersion: options.packageVersion,
      expectedTag,
    };
  }

  if (!refName) {
    throw new Error(
      'Release tag policy failed: GITHUB_REF_TYPE=tag but GITHUB_REF_NAME is missing.',
    );
  }
  if (refName !== expectedTag) {
    throw new Error(
      'Release tag policy failed: tag "' +
        refName +
        '" does not match package version "' +
        options.packageVersion +
        '"; expected "' +
        expectedTag +
        '".',
    );
  }

  return {
    checked: true,
    refType,
    refName,
    packageVersion: options.packageVersion,
    expectedTag,
  };
}

export async function checkCurrentReleaseTag(options: {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ReleaseTagCheck> {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const env = options.env ?? process.env;
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as { version?: unknown };

  if (
    typeof packageJson.version !== 'string' ||
    packageJson.version.length === 0
  ) {
    throw new Error(
      'Release tag policy failed: package.json version is missing.',
    );
  }

  return checkReleaseTag({
    packageVersion: packageJson.version,
    refType: env.GITHUB_REF_TYPE,
    refName: env.GITHUB_REF_NAME,
  });
}

async function main(): Promise<void> {
  const result = await checkCurrentReleaseTag();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const entry = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (entry === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
