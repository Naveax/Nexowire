import { pathToFileURL } from 'node:url';

// Issue #487 was unintentionally closed by a negated trigger in PR #1135,
// then reopened. This is a conservative preflight for PR title/body and
// commit messages; it never modifies GitHub state or claims parser parity.
// GitHub also accepts OWNER/REPOSITORY#ISSUE after a closing keyword.
// Only a matching qualified repository should count for the target issue;
// bare #ISSUE references are relative to the current repository.
const closingVerb = /\b(?:close[sd]?|fix(?:es|ed)?|resolv(?:e|es|ed))\s*:?\s*(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#([1-9]\d*)\b/gi;
const repositoryPattern = /^[a-z0-9-]+\/[a-z0-9_.-]+$/i;

export function detectUnsafeClosingRefs(text, issueNumbers = [487], repositoryFullName = 'Naveax/Nexowire') {
  if (typeof text !== 'string' || !Array.isArray(issueNumbers) ||
      issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) ||
      typeof repositoryFullName !== 'string' || !repositoryPattern.test(repositoryFullName))
    throw new TypeError('Invalid text or issue-number allowlist');
  const protectedNumbers = new Set(issueNumbers);
  const targetRepository = repositoryFullName.toLowerCase();
  return Array.from(text.matchAll(closingVerb))
    .filter((match) => protectedNumbers.has(Number(match[2])) &&
      (!match[1] || match[1].toLowerCase() === targetRepository))
    .map((match) => ({ issue: Number(match[2]), phrase: match[0], index: match.index,
      reason: 'UNINTENDED_ISSUE_CLOSING_RISK' }));
}

export function reviewPullRequestText({ title, body, commits = [] }, issueNumbers = [487], repositoryFullName = 'Naveax/Nexowire') {
  if (!Array.isArray(commits) || commits.some((message) => typeof message !== 'string'))
    throw new TypeError('Commit messages must be strings');
  return [
    { location: 'title', text: title },
    { location: 'body', text: body },
    ...commits.map((text, i) => ({ location: `commit:${i + 1}`, text })),
  ].flatMap(({ location, text }) => detectUnsafeClosingRefs(text, issueNumbers, repositoryFullName)
    .map((risk) => ({ location, ...risk })));
}

export const suggestedSafeWording = 'Acceptance for issue #487 remains open; no issue closure is requested.';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sample = { title: 'Read-only #487 acceptance matrix',
    body: suggestedSafeWording, commits: ['test(qa): verify state separation'] };
  process.stdout.write(`ISSUE #487 ACTIVE\nCLOSING_RISKS ${reviewPullRequestText(sample).length}\n`);
}
