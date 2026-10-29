/**
 * #11 SYSTEM QA ONLY: inspect a caller-supplied GitHub Actions snapshot.
 *
 * This is NOT a GitHub API authenticator or a production CORE authorization gate.
 * Even a fully consistent or all-green snapshot is UNTRUSTED and cannot establish
 * external CAS, publisher, Windows High-token/ACL, enrollment or physical soak.
 */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REQUIRED_JOBS = [
  'test (22)',
  'test (24)',
  'browser-live',
  'linux-native-live',
  'wsl2-live',
  'security-operational-live',
  'macos-agent-lifecycle-live',
] as const;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const sha40 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const positiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export interface CoreCiExpectation {
  readonly runId: number;
  readonly headSha: string;
  readonly workflowId: number;
}

export interface CoreCiSnapshot {
  readonly expected: CoreCiExpectation;
  readonly run: unknown;
  readonly jobs: unknown;
}

export interface CoreCiAudit {
  readonly schemaVersion: 1;
  readonly snapshotConsistency: 'CONSISTENT' | 'BLOCKED';
  readonly findings: readonly string[];
  /** A saved JSON snapshot is caller-supplied, not authenticated GitHub data. */
  readonly githubOriginAuthenticated: false;
  readonly physicalAcceptance: 'NOT_PROVEN';
  readonly productionCore: 'NO_GO';
  readonly requiredJobs: readonly string[];
}

export function auditCoreCiSnapshot(input: unknown): CoreCiAudit {
  const findings: string[] = [];
  const add = (reason: string): void => {
    if (!findings.includes(reason)) findings.push(reason);
  };
  if (!record(input)) {
    add('SNAPSHOT_INVALID');
  } else {
    const expected = input.expected;
    const run = input.run;
    const jobs = input.jobs;
    if (!record(expected) ||
        !positiveId(expected.runId) ||
        !positiveId(expected.workflowId) ||
        !sha40(expected.headSha)) {
      add('EXPECTATION_INVALID');
    }
    if (!record(run)) {
      add('RUN_METADATA_MISSING');
    } else {
      if (!record(expected) || run.id !== expected.runId) add('RUN_ID_MISMATCH');
      if (!record(expected) || run.workflow_id !== expected.workflowId) {
        add('WORKFLOW_ID_MISMATCH');
      }
      if (!record(expected) || !sha40(run.head_sha) ||
          run.head_sha !== expected.headSha) add('EXACT_SHA_MISMATCH');
      if (run.status !== 'completed' || run.conclusion !== 'success') {
        add('RUN_NOT_SUCCESSFUL');
      }
      if (!positiveId(run.run_attempt)) add('ATTEMPT_INVALID');
      if (!['pull_request', 'workflow_dispatch', 'push'].includes(
        typeof run.event === 'string' ? run.event : '')) {
        add('EVENT_INVALID');
      }
    }
    if (!Array.isArray(jobs) || jobs.length !== REQUIRED_JOBS.length) {
      add('JOB_CARDINALITY_MISMATCH');
    }
    if (Array.isArray(jobs)) {
      const found = new Set<string>();
      for (const job of jobs) {
        if (!record(job) || typeof job.name !== 'string') {
          add('JOB_METADATA_INVALID');
          continue;
        }
        if (found.has(job.name)) add('DUPLICATE_JOB_NAME');
        found.add(job.name);
        if (!REQUIRED_JOBS.includes(job.name as typeof REQUIRED_JOBS[number])) {
          add('UNEXPECTED_JOB');
        }
        if (!record(expected) || job.run_id !== expected.runId) {
          add('JOB_RUN_ID_MISMATCH');
        }
        if (job.head_sha !== undefined &&
            (!record(expected) || !sha40(job.head_sha) ||
             job.head_sha !== expected.headSha)) {
          add('JOB_SHA_MISMATCH');
        }
        if (job.status !== 'completed' || job.conclusion !== 'success') {
          add('JOB_NOT_SUCCESSFUL');
        }
      }
      for (const name of REQUIRED_JOBS) {
        if (!found.has(name)) add('REQUIRED_JOB_MISSING');
      }
    }
  }
  return {
    schemaVersion: 1,
    snapshotConsistency: findings.length === 0 ? 'CONSISTENT' : 'BLOCKED',
    findings,
    githubOriginAuthenticated: false,
    physicalAcceptance: 'NOT_PROVEN',
    productionCore: 'NO_GO',
    requiredJobs: REQUIRED_JOBS,
  };
}

// CLI usage: node --import tsx scripts/qa-core-ci-evidence-audit.ts snapshot.json
// A zero exit code only means the untrusted snapshot is internally consistent.
if (process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || process.argv.length !== 3) {
      throw new Error('Expected exactly one local JSON snapshot path.');
    }
    const contents = await readFile(process.argv[2], 'utf8');
    if (contents.length > 1024 * 1024) throw new Error('Snapshot exceeds 1 MiB.');
    const result = auditCoreCiSnapshot(JSON.parse(contents) as unknown);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.snapshotConsistency !== 'CONSISTENT') process.exitCode = 2;
  } catch {
    process.stderr.write('Invalid or unavailable QA snapshot; no acceptance inferred.\n');
    process.exitCode = 2;
  }
}
