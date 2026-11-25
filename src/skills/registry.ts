import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  evaluateSkillManifest,
  parseSkillManifest,
  type SkillEvaluation,
  type SkillManifest,
} from './manifest.js';

export interface SkillSummary extends SkillManifest {
  evaluation?: SkillEvaluation;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  markdown: string;
}

export class SkillRegistry {
  constructor(private readonly skillsDir: string) {}

  async list(options: {
    capabilities?: readonly string[];
    platform?: NodeJS.Platform;
  } = {}): Promise<SkillSummary[]> {
    let entries;
    try {
      entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const skills: SkillSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const loaded = await this.load(entry.name);
        const evaluation =
          options.capabilities !== undefined ||
          options.platform !== undefined
            ? evaluateSkillManifest(loaded.manifest, options)
            : undefined;
        skills.push({
          ...loaded.manifest,
          ...(evaluation ? { evaluation } : {}),
        });
      } catch {
        // Ignore incomplete or invalid skill directories in normal discovery.
        // validate() exposes them explicitly for maintenance/CI.
      }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name: string): Promise<LoadedSkill> {
    this.assertName(name);
    // Discovery ignores symlinked directories. Direct loading must enforce
    // the same rule; otherwise a caller can read a manifest outside the catalog.
    const catalogRoot = await fs.realpath(this.skillsDir);
    const skillDirectory = path.join(this.skillsDir, name);
    const directoryStat = await fs.lstat(skillDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Skill directory must be a regular directory.');
    }
    const realDirectory = await fs.realpath(skillDirectory);
    if (path.relative(catalogRoot, realDirectory) !== name) {
      throw new Error('Skill directory escapes the configured catalog.');
    }

    const manifestPath = path.join(realDirectory, 'SKILL.md');
    const manifestStat = await fs.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error('Skill manifest must be a regular file.');
    }
    const realManifest = await fs.realpath(manifestPath);
    if (path.dirname(realManifest) !== realDirectory) {
      throw new Error('Skill manifest escapes its directory.');
    }
    // O_NOFOLLOW prevents a last-component link swap on POSIX. Compare the
    // opened inode with the preceding lstat before reading either platform.
    const flags = fsConstants.O_RDONLY |
      (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW);
    const handle = await fs.open(realManifest, flags);
    let markdown: string;
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() ||
          openedStat.dev !== manifestStat.dev ||
          openedStat.ino !== manifestStat.ino) {
        throw new Error('Skill manifest changed while opening.');
      }
      markdown = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const manifest = parseSkillManifest(markdown, name);
    if (manifest.name !== name) {
      throw new Error(
        `Skill manifest name "${manifest.name}" does not match directory "${name}".`,
      );
    }
    return { manifest, markdown };
  }

  async read(name: string): Promise<string> {
    return (await this.load(name)).markdown;
  }

  async validate(): Promise<{
    ok: boolean;
    valid: SkillManifest[];
    errors: Array<{ directory: string; error: string }>;
  }> {
    let entries;
    try {
      entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    } catch (error) {
      return {
        ok: false,
        valid: [],
        errors: [
          {
            directory: this.skillsDir,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
        ],
      };
    }

    const valid: SkillManifest[] = [];
    const errors: Array<{ directory: string; error: string }> = [];
    const names = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const { manifest } = await this.load(entry.name);
        if (names.has(manifest.name)) {
          throw new Error(
            `Duplicate skill manifest name: ${manifest.name}`,
          );
        }
        names.add(manifest.name);
        valid.push(manifest);
      } catch (error) {
        errors.push({
          directory: entry.name,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }

    valid.sort((a, b) => a.name.localeCompare(b.name));
    errors.sort((a, b) => a.directory.localeCompare(b.directory));

    return {
      ok: errors.length === 0,
      valid,
      errors,
    };
  }

  private assertName(name: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) {
      throw new Error('Invalid skill name.');
    }
  }
}
