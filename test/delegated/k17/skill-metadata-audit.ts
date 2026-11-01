import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSkillManifest } from '../../../src/skills/manifest.js';

export interface SkillMetadataIssue {
  code: string;
  detail: string;
}

export function headingSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function frontmatterLines(markdown: string): string[] {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return [];
  const closing = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  return closing > 0 ? lines.slice(1, closing) : [];
}

export function auditSkillMetadata(
  directory: string,
  markdown: string,
): SkillMetadataIssue[] {
  const issues: SkillMetadataIssue[] = [];
  const header = frontmatterLines(markdown);

  for (const key of ['name', 'description', 'version']) {
    const occurrences = header.filter((line) =>
      new RegExp(`^\\s*${key}\\s*:`, 'i').test(line),
    );
    if (occurrences.length !== 1) {
      issues.push({
        code: 'frontmatter-field',
        detail: `${directory}: expected one explicit ${key} field; found ${occurrences.length}`,
      });
    }
  }
  for (const key of ['requires', 'platforms', 'mutation', 'privilege', 'trust']) {
    if (header.some((line) => new RegExp(`^\\s*${key}\\s*:\\s*$`, 'i').test(line))) {
      issues.push({
        code: 'blank-declaration',
        detail: `${directory}: explicit ${key} declaration is empty; do not infer permission or support`,
      });
    }
  }
  if (!header.some((line) => /^\s*platforms\s*:\s*\S/i.test(line))) {
    issues.push({
      code: 'platform-unknown',
      detail: `${directory}: no explicit platform support declaration; support is UNKNOWN for this audit`,
    });
  }

  try {
    const manifest = parseSkillManifest(markdown, directory);
    if (manifest.name !== directory) {
      issues.push({
        code: 'directory-name',
        detail: `${directory}: manifest name is ${manifest.name}`,
      });
    }
    if (manifest.description.trim().length < 20) {
      issues.push({
        code: 'description-quality',
        detail: `${directory}: description is shorter than 20 characters`,
      });
    }
  } catch (error) {
    issues.push({
      code: 'invalid-manifest',
      detail: `${directory}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const headings = [...markdown.matchAll(/^#\s+(.+?)\s*$/gm)].map(
    (match) => match[1] ?? '',
  );
  if (headings.length !== 1 || headingSlug(headings[0] ?? '') !== directory) {
    issues.push({
      code: 'title-path',
      detail: `${directory}: expected a single H1 title corresponding to its directory; found ${JSON.stringify(headings)}`,
    });
  }

  return issues;
}

// Deliberately narrow: detect affirmative instructions to bypass admission or
// permission checks, not text that warns readers *against* those actions.
export function auditUnsafeInstructions(markdown: string): SkillMetadataIssue[] {
  const issues: SkillMetadataIssue[] = [];
  let inFence = false;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const instruction = line.trim().replace(/^(?:[-*]|\d+\.)\s+/, '');
    if (/^(?:do not|don't|never|avoid|must not|should not)\b/i.test(instruction)) {
      continue;
    }
    if (
      /\b(?:bypass|disable|skip|ignore|turn off)\s+(?:the\s+)?(?:authentication|authorization|auth\b|access[ -]?control|permission(?:s| checks?)?|security checks?|uac\b)/i.test(instruction) ||
      /\b(?:run|execute)\s+as\s+(?:admin(?:istrator)?|root)\s+without\s+(?:approval|authorization|permission)/i.test(instruction)
    ) {
      issues.push({
        code: 'unsafe-instruction',
        detail: `line ${index + 1}: ${instruction}`,
      });
    }
  }
  return issues;
}

export async function auditLocalMarkdownLinks(
  markdownPath: string,
  markdown: string,
  repositoryRoot: string,
): Promise<SkillMetadataIssue[]> {
  const issues: SkillMetadataIssue[] = [];
  // Only inline Markdown links are checked; remote URLs are never fetched.
  const links = [...markdown.matchAll(/!?\[[^\]\n]+\]\((<?[^)\s>]+>?)(?:\s+['"][^'"]+['"])?\)/g)];
  for (const link of links) {
    const raw = (link[1] ?? '').replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:)/i.test(raw)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) {
      issues.push({ code: 'link-scheme', detail: `${markdownPath}: unsupported link ${raw}` });
      continue;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      issues.push({ code: 'link-encoding', detail: `${markdownPath}: invalid URI encoding ${raw}` });
      continue;
    }
    const [relative, fragment] = decoded.split('#', 2);
    const target = relative
      ? path.resolve(path.dirname(markdownPath), relative)
      : markdownPath;
    const inside = path.relative(repositoryRoot, target);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      issues.push({ code: 'link-outside-repo', detail: `${markdownPath}: ${raw}` });
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      issues.push({ code: 'link-missing', detail: `${markdownPath}: ${raw}` });
      continue;
    }
    // A path may be lexically inside the checkout yet resolve through a
    // symlink to a different filesystem subtree. Never follow such links.
    const resolvedRoot = await fs.realpath(repositoryRoot);
    const resolvedTarget = await fs.realpath(target);
    const resolvedRelative = path.relative(resolvedRoot, resolvedTarget);
    if (
      resolvedRelative === '..' ||
      resolvedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolvedRelative)
    ) {
      issues.push({ code: 'link-outside-repo', detail: `${markdownPath}: ${raw} follows a link outside repo` });
      continue;
    }
    if (!fragment) continue;
    if (!stat.isFile()) {
      issues.push({ code: 'link-anchor', detail: `${markdownPath}: ${raw} does not target a file` });
      continue;
    }
    const targetMarkdown = relative ? await fs.readFile(target, 'utf8') : markdown;
    const anchors = [...targetMarkdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)]
      .map((match) => headingSlug(match[1] ?? ''));
    if (!anchors.includes(headingSlug(fragment))) {
      issues.push({ code: 'link-anchor', detail: `${markdownPath}: ${raw}` });
    }
  }
  return issues;
}
