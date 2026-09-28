import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SkillSummary {
  name: string;
  description: string;
}

function parseField(markdown: string, field: string): string | undefined {
  const match = markdown.match(
    new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, 'im'),
  );
  return match?.[1]?.replace(/^["']|["']$/g, '').trim();
}

export class SkillRegistry {
  constructor(private readonly skillsDir: string) {}

  async list(): Promise<SkillSummary[]> {
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
        const markdown = await fs.readFile(
          path.join(this.skillsDir, entry.name, 'SKILL.md'),
          'utf8',
        );
        skills.push({
          name: parseField(markdown, 'name') ?? entry.name,
          description:
            parseField(markdown, 'description') ??
            'No skill description has been provided.',
        });
      } catch {
        // Ignore incomplete skill directories.
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) {
      throw new Error('Invalid skill name.');
    }
    return await fs.readFile(
      path.join(this.skillsDir, name, 'SKILL.md'),
      'utf8',
    );
  }
}
