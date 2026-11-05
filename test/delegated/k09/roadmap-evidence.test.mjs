import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const roadmap = readFileSync(resolve(root, 'ROADMAP.md'), 'utf8');
const scale = readFileSync(resolve(root, 'docs/SCALE_V2_ROADMAP.md'), 'utf8');
const exactSha = /`[0-9a-f]{40}`/;

function audit(rootDoc, scaleDoc) {
  const errors = [];
  const requireText = (text, needle, reason) => {
    if (!text.includes(needle)) errors.push(reason);
  };

  requireText(rootDoc, 'Status and evidence convention (snapshot:', 'Root roadmap lacks dated status convention');
  requireText(rootDoc, 'RELEASED', 'Published release is not distinguished from implementation');
  requireText(rootDoc, 'DEPLOYED / ACCEPTED', 'Live acceptance is not distinguished from release');
  requireText(rootDoc, 'UNKNOWN / NOT_RUN', 'Unknown live evidence is not explicit');
  requireText(rootDoc, 'v1.0.8', 'Published release version is missing from dated snapshot');
  requireText(rootDoc, 'docs/SCALE_V2_ROADMAP.md#evidence-ledger-', 'Root-to-scale ledger link is missing');
  requireText(scaleDoc, '## Evidence ledger (snapshot:', 'Scale ledger lacks snapshot date');
  requireText(scaleDoc, '[ROADMAP.md](../ROADMAP.md)', 'Scale-to-root link is missing');
  requireText(scaleDoc, 'author-reported', 'PR-reported tests are not distinguished from independent tests');
  requireText(scaleDoc, 'UNKNOWN / NOT_RUN', 'Unmeasured cost or acceptance must stay unknown');

  if (!/commit\/[0-9a-f]{40}/.test(rootDoc)) errors.push('Root source snapshot needs exact commit evidence');

  const ledger = scaleDoc.split('### User-visible acceptance and measurement dependencies')[0];
  const acceptance = scaleDoc.split('### User-visible acceptance and measurement dependencies')[1]?.split('## S0:')[0] ?? '';
  for (let n = 1; n <= 5; n++) {
    const row = ledger.split('\n').find((line) => line.startsWith(`| S${n} `));
    if (!row || !row.includes('Draft') || !row.includes('NO-GO') || !exactSha.test(row)) {
      errors.push(`S${n} needs a draft/source exact HEAD and explicit NO-GO`);
    }
    if (!acceptance.split('\n').some((line) => line.startsWith(`| S${n} |`))) {
      errors.push(`S${n} lacks user-visible acceptance and dependency`);
    }
    const section = scaleDoc.match(new RegExp(`^## S${n}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## S\\d\\b|^## Cross-cutting|(?![\\s\\S]))`, 'm'))?.[1];
    if (!section) {
      errors.push(`S${n} gate section absent`);
    } else if (/^- \[x\]/m.test(section)) {
      errors.push(`S${n} contains a newly checked item without a corresponding live gate review`);
    }
  }
  return errors;
}

test('roadmaps separate plan, source candidate, release, and live acceptance', () => {
  assert.deepEqual(audit(roadmap, scale), []);
});

test('regression: a prematurely checked S2 gate is rejected', () => {
  const incorrectlyChecked = scale.replace(
    '- [ ] Lock policy version:',
    '- [x] Lock policy version:',
  );
  assert.notEqual(incorrectlyChecked, scale);
  assert.match(audit(roadmap, incorrectlyChecked).join('\n'), /S2 contains a newly checked item/);
});

test('regression: candidate without exact HEAD or NO-GO is rejected', () => {
  const falsePass = scale.replace(/(\| S5 scale\/cost \|[^\n]*)/, (row) =>
    row.replace(/`[0-9a-f]{40}`/, '`unknown`').replace('NO-GO', 'PASS'));
  assert.notEqual(falsePass, scale);
  assert.match(audit(roadmap, falsePass).join('\n'), /S5 needs a draft\/source exact HEAD and explicit NO-GO/);
});

test('regression: removing the live-status distinction is rejected', () => {
  const noLiveDefinition = roadmap.replace('DEPLOYED / ACCEPTED', 'UNSPECIFIED');
  assert.match(audit(noLiveDefinition, scale).join('\n'), /Live acceptance is not distinguished/);
});
