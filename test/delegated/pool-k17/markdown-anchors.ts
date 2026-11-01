export interface HeadingAnchor {
  line: number;
  heading: string;
  anchor: string;
}

export interface AnchorProblem {
  line: number;
  kind: 'duplicate-id' | 'missing-target';
  target: string;
}

function slug(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function withoutFencedCode(markdown: string): Array<{ line: number; content: string }> {
  let fence: { marker: string; length: number } | undefined;
  const visible: Array<{ line: number; content: string }> = [];
  for (const [index, content] of markdown.split(/\r?\n/).entries()) {
    const opening = content.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (opening && opening[1]?.[0] === fence.marker && opening[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (opening) {
      fence = { marker: opening[1]?.[0] ?? '`', length: opening[1]?.length ?? 3 };
      continue;
    }
    visible.push({ line: index + 1, content });
  }
  return visible;
}

/**
 * Static, offline subset of GitHub-style heading IDs. Duplicate headings are
 * disambiguated rather than treated as broken; a requested fragment must name
 * the exact resulting ID. This is not a complete Markdown/browser renderer.
 */
export function indexHeadingAnchors(markdown: string): HeadingAnchor[] {
  const result: HeadingAnchor[] = [];
  const used = new Set<string>();
  for (const { line, content } of withoutFencedCode(markdown)) {
    const match = content.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const heading = match[1] ?? '';
    const base = slug(heading);
    if (!base) continue;
    let anchor = base;
    for (let index = 1; used.has(anchor); index++) {
      anchor = `${base}-${index}`;
    }
    used.add(anchor);
    result.push({ line, heading, anchor });
  }
  return result;
}

/**
 * Reports duplicate explicit HTML IDs and invalid same-page Markdown links.
 * Relative file links are deliberately out of scope (handled by link QA).
 */
export function auditSamePageAnchors(markdown: string): AnchorProblem[] {
  const visible = withoutFencedCode(markdown);
  const anchors = new Set(indexHeadingAnchors(markdown).map((item) => item.anchor));
  const problems: AnchorProblem[] = [];

  for (const { line, content } of visible) {
    for (const match of content.matchAll(/<a\s+[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
      const anchor = match[1] ?? '';
      if (anchors.has(anchor)) {
        problems.push({ line, kind: 'duplicate-id', target: anchor });
      } else {
        anchors.add(anchor);
      }
    }
  }

  for (const { line, content } of visible) {
    for (const match of content.matchAll(/!?\[[^\]\n]+\]\(#([^)\s]+)\)/g)) {
      let anchor: string;
      try {
        anchor = decodeURIComponent(match[1] ?? '');
      } catch {
        problems.push({ line, kind: 'missing-target', target: match[1] ?? '' });
        continue;
      }
      if (!anchors.has(anchor)) {
        problems.push({ line, kind: 'missing-target', target: anchor });
      }
    }
  }
  return problems;
}
