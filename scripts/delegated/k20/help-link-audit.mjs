#!/usr/bin/env node
// Read-only static audit: a valid href is NOT evidence that a remote URL works.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function inside(root, file) {
  const path = relative(root, file);
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
}

function attributes(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return attrs;
}

function helpAnchors(html) {
  const anchors = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = attributes(m[1]);
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/yardım|rehber|bilgi|help|sha-256|download raw/i.test(label) ||
        /^(download-installer|verify-installer)$/.test(attrs.id || '')) {
      anchors.push({ label, attrs, line: html.slice(0, m.index).split('\n').length });
    }
  }
  return anchors;
}

export function auditHelpLinks(repoRoot, htmlPaths) {
  const root = realpathSync(repoRoot);
  const findings = [], links = [];
  for (const path of htmlPaths) {
    const source = realpathSync(path);
    if (!inside(root, source)) throw new Error('Source outside repository');
    const html = readFileSync(source, 'utf8');
    for (const { label, attrs, line } of helpAnchors(html)) {
      const href = attrs.href || '';
      const link = { file: relative(root, source), line, label, href, state: 'NOT_RUN', kind: 'unknown' };
      const fail = problem => findings.push({ file: link.file, line, problem, href });
      if (!href) fail('missing-href');
      else if (/^https?:\/\//i.test(href)) {
        link.kind = 'external';
        try {
          const u = new URL(href);
          if (u.protocol !== 'https:' || u.username || u.password) fail('unsafe-external-url');
        } catch { fail('invalid-url'); }
      } else if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('//')) {
        fail('unsupported-or-unsafe-scheme');
      } else if (href.startsWith('/')) {
        link.kind = 'runtime-route';
        // Cannot prove an authenticated runtime route exists in an HTML fixture.
      } else {
        link.kind = 'local';
        let unescaped;
        try { unescaped = decodeURIComponent(href); }
        catch { fail('invalid-encoding'); links.push(link); continue; }
        const [fileName, fragment] = unescaped.split('#', 2);
        const target = resolve(dirname(source), fileName || '.');
        if (!inside(root, target)) fail('outside-repository');
        else if (!existsSync(target)) fail('missing-target');
        else if (!inside(root, realpathSync(target))) fail('symlink-outside-repository');
        else if (fragment && extname(target).toLowerCase() === '.html') {
          const ids = [...readFileSync(target, 'utf8').matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
            .map(m => m[1] ?? m[2]);
          if (!ids.includes(fragment)) fail('missing-fragment');
        }
        if (!findings.some(f => f.file === link.file && f.line === line)) link.state = 'STATIC_OK';
      }
      if (attrs.target === '_blank' &&
          !/\bnoopener\b/.test(attrs.rel || '')) fail('blank-target-without-noopener');
      links.push(link);
    }
  }
  return { links, findings, externalNotVerified: links.filter(x => x.kind === 'external').length,
    runtimeNotVerified: links.filter(x => x.kind === 'runtime-route').length };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--root' || !args[1]) throw new Error('Usage: help-link-audit.mjs --root repo [relative HTML paths...]');
  const root = realpathSync(args[1]);
  const files = args.slice(2).length ? args.slice(2) : readdirSync(join(root, 'web')).filter(x => x.endsWith('.html')).map(x => 'web/' + x);
  const report = auditHelpLinks(root, files.map(x => resolve(root, x)));
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 help: ${err.message}`); process.exitCode = 2; }
}
