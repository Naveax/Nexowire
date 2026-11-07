import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface CatalogueFinding {
  directory: string;
  code: 'missing-manifest' | 'symlink-entry' | 'symlink-manifest' |
    'duplicate-field' | 'identity-mismatch' | 'platform-unknown' |
    'unsupported-platform-claim';
  detail: string;
}

export interface CatalogueAudit {
  directories: number;
  findings: CatalogueFinding[];
}

const platformTerms: Record<string, string> = {
  windows: 'win32',
  linux: 'linux',
  macos: 'darwin',
};

/** Only explicit text claims are checked; platform mentions alone are not promises. */
export function auditManifestText(directory: string, markdown: string): CatalogueFinding[] {
  const findings: CatalogueFinding[] = [];
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const ending = lines[0]?.trim() === '---'
    ? lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    : -1;
  const frontmatter = ending > 0 ? lines.slice(1, ending) : [];
  const fields = new Map<string, string>();

  for (const line of frontmatter) {
    const match = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = (match[1] ?? '').toLowerCase();
    if (fields.has(key)) {
      findings.push({ directory, code: 'duplicate-field', detail: key });
    }
    fields.set(key, match[2] ?? '');
  }

  if (fields.get('name') !== directory) {
    findings.push({
      directory,
      code: 'identity-mismatch',
      detail: `manifest=${JSON.stringify(fields.get('name') ?? null)}`,
    });
  }

  // The runtime parser defaults omitted platforms to `any`. That is not
  // evidence of platform support; this diagnostic reports it as UNKNOWN.
  const platformsRaw = fields.get('platforms')?.trim() ?? '';
  if (!platformsRaw) {
    findings.push({
      directory,
      code: 'platform-unknown',
      detail: 'No explicit non-empty platforms declaration',
    });
    return findings;
  }

  const platforms = new Set(platformsRaw.split(',').map((value) => value.trim()));
  const description = fields.get('description') ?? '';
  const claimed = [...description.matchAll(/\b(?:supports|runs on|works on|available on)\s+(windows|linux|macos)\b/gi)]
    .map((match) => (match[1] ?? '').toLowerCase());
  for (const claim of new Set(claimed)) {
    const expected = platformTerms[claim];
    if (expected && !platforms.has(expected) && !platforms.has('any')) {
      findings.push({
        directory,
        code: 'unsupported-platform-claim',
        detail: `${claim} claimed in description; declared ${platformsRaw}`,
      });
    }
  }
  return findings;
}

/** Filesystem-only inventory; never follows a symlinked skill or manifest. */
export async function auditSkillCatalogue(root: string): Promise<CatalogueAudit> {
  const findings: CatalogueFinding[] = [];
  let directories = 0;
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      findings.push({
        directory: entry.name,
        code: 'symlink-entry',
        detail: 'Symbolic-link skill directory; excluded without reading its target',
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    directories++;

    const file = path.join(root, entry.name, 'SKILL.md');
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch {
      findings.push({ directory: entry.name, code: 'missing-manifest', detail: 'No SKILL.md' });
      continue;
    }
    if (stat.isSymbolicLink()) {
      findings.push({
        directory: entry.name,
        code: 'symlink-manifest',
        detail: 'SKILL.md is a symbolic link; excluded without reading its target',
      });
      continue;
    }
    if (!stat.isFile()) {
      findings.push({ directory: entry.name, code: 'missing-manifest', detail: 'SKILL.md is not a regular file' });
      continue;
    }
    findings.push(...auditManifestText(entry.name, await fs.readFile(file, 'utf8')));
  }

  return { directories, findings };
}
