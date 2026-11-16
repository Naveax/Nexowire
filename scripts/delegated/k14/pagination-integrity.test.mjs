import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSnapshot } from './integration-report.mjs';

const MAIN = 'a'.repeat(40);
const FORK = 'SinsiVinci/Nexowire-fork';
const ordinaryPr = number => ({
  number,
  title: `PR ${number}`,
  state: 'open',
  draft: true,
  user: { login: 'fixture' },
  head: { sha: MAIN, repo: { full_name: [1, 101, 373].includes(number) ? FORK : 'Other/Repo' } },
  base: { sha: MAIN },
});

function mockGitHub(pageNumbers) {
  const calls = [];
  const byNumber = new Map(pageNumbers.flat().map(number => [number, ordinaryPr(number)]));
  const get = async path => {
    calls.push(path);
    if (path === '/repos/Naveax/Nexowire/branches/main' || path === '/repos/SinsiVinci/Nexowire-fork/branches/main') return { commit: { sha: MAIN } };
    if (path.startsWith('/repos/Naveax/Nexowire/pulls?state=open')) {
      const number = Number(new URL(path, 'https://github.invalid').searchParams.get('page'));
      return (pageNumbers[number - 1] ?? []).map(n => byNumber.get(n));
    }
    if (/\/pulls\/\d+\/files/.test(path)) return [];
    const match = path.match(/\/pulls\/(\d+)$/);
    if (match) return byNumber.get(Number(match[1]));
    throw new Error(`Unexpected mocked request ${path}`);
  };
  return { get, calls };
}

function ranges(total, pageSize = 100) {
  const result = [];
  for (let start = 1; start <= total; start += pageSize) {
    result.push(Array.from({ length: Math.min(pageSize, total - start + 1) }, (_, offset) => start + offset));
  }
  return result;
}

test('101 open PRs: second page is included instead of silently capped at 100', async () => {
  const { get, calls } = mockGitHub(ranges(101));
  const report = await collectSnapshot(get);
  assert.deepEqual(report.prs.map(pr => pr.number), [1, 101]);
  assert.ok(calls.some(path => path.includes('per_page=100&page=2')));
});

test('373 open PRs: four full/partial pages include the last fork PR', async () => {
  const { get, calls } = mockGitHub(ranges(373));
  const report = await collectSnapshot(get);
  assert.deepEqual(report.prs.map(pr => pr.number), [1, 101, 373]);
  assert.equal(calls.filter(path => path.includes('pulls?state=open')).length, 4);
});

test('exactly 100 open PRs requires an additional empty terminal page', async () => {
  const { get, calls } = mockGitHub(ranges(100));
  await collectSnapshot(get);
  assert.equal(calls.filter(path => path.includes('pulls?state=open')).length, 2);
});

test('six completely full pages fail closed without claiming a complete PR inventory', async () => {
  const { get } = mockGitHub(ranges(601));
  await assert.rejects(collectSnapshot(get), /PR listing incomplete/);
});

test('duplicate PR across shifting page boundaries must fail rather than omit one silently', async () => {
  const pages = ranges(173);
  pages[1] = [100, ...pages[1].slice(0, 72)]; // #100 repeated, #173 omitted: two 100/73 pages look superficially complete.
  const { get } = mockGitHub(pages);
  await assert.rejects(collectSnapshot(get), /duplicate.*PR|PR.*duplicate/i);
});

test('a failed page request must not be treated as an empty last page', async () => {
  const { get } = mockGitHub(ranges(101));
  await assert.rejects(collectSnapshot(async path => {
    if (path.includes('pulls?state=open') && path.includes('page=2')) throw new Error('HTTP 502 page 2');
    return get(path);
  }), /HTTP 502/);
});
