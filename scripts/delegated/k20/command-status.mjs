#!/usr/bin/env node
/** Safe default is inspect-only; --run executes package checks explicitly. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const STAGES = Object.freeze([
  { name: 'typecheck', script: 'typecheck' },
  { name: 'build', script: 'build' },
  { name: 'test', script: 'test' },
]);

export function checkScriptDefinitions(pkg) {
  if (!pkg?.scripts || typeof pkg.scripts !== 'object') throw new Error('No package scripts');
  return STAGES.map(stage => ({ ...stage, command: `npm run ${stage.script}`,
    defined: typeof pkg.scripts[stage.script] === 'string' && !!pkg.scripts[stage.script].trim() }));
}

export function classify(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (result.error || result.status === null) return 'NOT_RUN';
  return result.status === 0 ? 'PASS' : 'FAIL';
}

export function executeStage(stage, cwd, timeout = 120_000) {
  const outcome = spawnSync('npm', ['run', stage.script], {
    cwd, encoding: 'utf8', timeout, maxBuffer: 512 * 1024, shell: false,
    env: { ...process.env, CI: '1' },
  });
  return { name: stage.name, command: `npm run ${stage.script}`,
    status: classify(outcome), exitCode: outcome.status,
    signal: outcome.signal || null, errorCode: outcome.error?.code || null };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(x => !['--run', '--dry-run'].includes(x)) || args.length > 1) {
    throw new Error('Usage: node command-status.mjs [--run]; default dry-run');
  }
  const stages = checkScriptDefinitions(JSON.parse(readFileSync('package.json', 'utf8')));
  const results = stages.map(stage => !stage.defined
    ? { name: stage.name, command: stage.command, status: 'NOT_RUN', reason: 'SCRIPT_MISSING' }
    : args.includes('--run') ? executeStage(stage, process.cwd())
      : { name: stage.name, command: stage.command, status: 'NOT_RUN', reason: 'DRY_RUN' });
  console.log(JSON.stringify(results, null, 2));
  if (results.some(x => x.status === 'FAIL' || x.status === 'TIMEOUT')) process.exitCode = 1;
  if (results.some(x => !x.status || (x.status === 'NOT_RUN' && x.reason === 'SCRIPT_MISSING'))) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 stages: ${err.message}`); process.exitCode = 2; }
}
