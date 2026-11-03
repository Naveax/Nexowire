import { posix } from 'node:path';

// Normalize test/fixture labels without leaking absolute workstation paths.
// Pure string handling means Windows paths can be checked on a Linux runner.
export function normalizeFixturePath(input, root) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) return '<unknown-fixture>';
  const slash = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = slash(input);
  const base = slash(typeof root === 'string' ? root : '');
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);
  let relativePath = path;
  if (absolute) {
    if (!base) return '<external-fixture>';
    const windows = /^[A-Za-z]:\//.test(path) || base.startsWith('//');
    const left = windows ? path.toLowerCase() : path;
    const right = windows ? base.toLowerCase() : base;
    if (left === right) return '<root-fixture>';
    if (!left.startsWith(right + '/')) return '<external-fixture>';
    relativePath = path.slice(base.length + 1);
  }
  // Strip non-semantic . and folder/.. segments; never accept escaping root.
  const parts = [];
  for (const part of relativePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return '<external-fixture>';
      parts.pop();
    } else if (part.includes(':')) {
      return '<external-fixture>';
    } else {
      parts.push(part);
    }
  }
  const result = posix.join(...parts);
  return result === '.' ? '<root-fixture>' : result;
}
