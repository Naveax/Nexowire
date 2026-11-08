import { pathToFileURL } from 'node:url';

// Issue #487 was unintentionally closed by a negated trigger in PR #1135,
// then reopened. This is a conservative preflight for PR title/body and
// commit messages; it never modifies GitHub state or claims parser parity.
const closingVerb = /\b(?:close[sd]?|fix(?:es|ed)?|resolv(?:e|es|ed))\s*:?\s*#([1-9]\d*)\b/gi;

export function detectUnsafeClosingRefs(text, issueNumbers = [487]) {
  if (typeof text !== 'string' || !Array.isArray(issueNumbers) ||
      issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new TypeError('Invalid text or issue-number allowlist');
  const protectedNumbers = new Set(issueNumbers);
  return Array.from(text.matchAll(closingVerb))
    .filter((match) => protectedNumbers.has(Number(match[1])))
    .map((match) => ({ issue: Number(match[1]), phrase: match[0], index: match.index,
      reason: 'UNINTENDED_ISSUE_CLOSING_RISK' }));
}

export function reviewPullRequestText({ title, body, commits = [] }, issueNumbers = [487]) {
  if (!Array.isArray(commits) || commits.some((message) => typeof message !== 'string'))
    throw new TypeError('Commit messages must be strings');
  return [
    { location: 'title', text: title },
    { location: 'body', text: body },
    ...commits.map((text, i) => ({ location: `commit:${i + 1}`, text })),
  ].flatMap(({ location, text }) => detectUnsafeClosingRefs(text, issueNumbers)
    .map((risk) => ({ location, ...risk })));
}

export const suggestedSafeWording = 'Acceptance for issue #487 remains open; no issue closure is requested.';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sample = { title: 'Read-only #487 acceptance matrix',
    body: suggestedSafeWording, commits: ['test(qa): verify state separation'] };
  process.stdout.write(`ISSUE #487 ACTIVE\nCLOSING_RISKS ${reviewPullRequestText(sample).length}\n`);
}
