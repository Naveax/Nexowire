#!/usr/bin/env node
/** Read-only checker for local Markdown link destinations and headings. */
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function within(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

function collectMarkdown(root, target, output = []) {
  if (!existsSync(target)) return output;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return output; // No traversal into external symlink trees.
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target).sort()) collectMarkdown(root, join(target, entry), output);
  } else if (stat.isFile() && extname(target).toLowerCase() === '.md' && within(root, target)) {
    output.push(target);
  }
  return output;
}

function plainLines(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      const type = marker[1][0];
      if (!fence) fence = { type, length: marker[1].length };
      else if (fence.type === type && marker[1].length >= fence.length) fence = null;
      return '';
    }
    if (fence) return '';
    // Ignore inline code containing illustrative link syntax.
    return line.replace(/(`+)(?:[^`]|(?!\1)`)*?\1/g, '');
  });
}

function headingIds(markdown) {
  const ids = new Set();
  const counts = new Map();
  for (const line of plainLines(markdown)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = heading[1].toLowerCase().replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}\-_ ]/gu, '')
      .replace(/ /g, '-');
    const n = counts.get(slug) || 0;
    counts.set(slug, n + 1);
    ids.add(n ? `${slug}-${n}` : slug);
  }
  for (const match of markdown.matchAll(/<(?:a|span)\s+(?:id|name)=["']([^"']+)["']/gi)) ids.add(match[1]);
  return ids;
}

function isExternal(url) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url);
}

function extractLinks(markdown) {
  const links = [];
  const lines = plainLines(markdown);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Inline Markdown destinations: optional angle brackets and optional title.
    for (const match of line.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g)) {
      links.push({ url: match[1].replace(/^<|>$/g, ''), line: index + 1 });
    }
  }
  return links;
}

/** Returns findings; no mutation, network, dynamic process or credential access. */
export function checkLinks(repoRoot, files) {
  const root = realpathSync(repoRoot);
  const findings = [];
  let checked = 0;
  let skippedExternal = 0;
  const headingCache = new Map();
  for (const file of files.sort()) {
    const source = realpathSync(file);
    if (!within(root, source)) throw new Error(`Source outside repository: ${file}`);
    for (const { url, line } of extractLinks(readFileSync(source, 'utf8'))) {
      if (isExternal(url)) { skippedExternal++; continue; }
      const [rawPath, rawAnchor] = url.split('#', 2);
      let localPath;
      let anchor;
      try {
        localPath = decodeURIComponent(rawPath.split('?', 1)[0]);
        anchor = rawAnchor === undefined ? undefined : decodeURIComponent(rawAnchor);
      } catch {
        findings.push({ file: relative(root, source), line, url, problem: 'invalid-percent-encoding' });
        continue;
      }
      // Root-relative URLs are website routes, not checkout-relative file links.
      if (localPath.startsWith('/')) { skippedExternal++; continue; }
      const target = resolve(dirname(source), localPath || '.');
      checked++;
      const fail = problem => findings.push({ file: relative(root, source), line, url, problem });
      if (!within(root, target)) { fail('outside-repository'); continue; }
      if (!existsSync(target)) { fail('missing-target'); continue; }
      if (!within(root, realpathSync(target))) { fail('symlink-outside-repository'); continue; }
      if (anchor && extname(target).toLowerCase() === '.md') {
        if (!headingCache.has(target)) headingCache.set(target, headingIds(readFileSync(target, 'utf8')));
        if (!headingCache.get(target).has(anchor)) fail('missing-heading');
      }
    }
  }
  return { files: files.length, checked, skippedExternal, findings };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== '--root') {
    throw new Error('Usage: node check-doc-links.mjs --root repo-dir [file-or-directory ...]');
  }
  const root = realpathSync(args[1]);
  const inputs = args.slice(2);
  const targets = inputs.length ? inputs : ['README.md', 'docs'];
  const files = [...new Set(targets.flatMap(target => {
    const full = resolve(root, target);
    if (!within(root, full)) throw new Error(`Target outside repository: ${target}`);
    return collectMarkdown(root, full);
  }))];
  const result = checkLinks(root, files);
  for (const finding of result.findings) {
    console.log(`${finding.file}:${finding.line} ${finding.problem}: ${finding.url}`);
  }
  console.log(`Checked ${result.checked} local links in ${result.files} Markdown files; ` +
    `${result.skippedExternal} external/site routes skipped; ${result.findings.length} findings.`);
  if (result.findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 links: ${err.message}`); process.exitCode = 2; }
}
