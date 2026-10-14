import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {
  scanNativeLaunches,collectNativeLaunches,
  countSignatures,compareLaunchInventory,
} from '../scripts/ai-screen-launch-paths.js';

test('AST recognizes named imports, aliases, namespaces, CommonJS and direct require',()=>{
  const code=[
    "import {spawn as run,execFileSync} from 'node:child_process';",
    "import * as cp from 'child_process';",
    "const {fork: forkWorker}=require('node:child_process');",
    "const others=require('child_process');",
    "run('node',[]);",
    "execFileSync('node',[]);",
    "cp.execFile('cmd.exe',[]);",
    "forkWorker('worker.js');",
    "others.spawnSync('node',[]);",
    "require('node:child_process').spawn('x',[]);",
  ].join('\n');
  const rows=scanNativeLaunches('src/agent/fixture.ts',code);
  assert.deepEqual(rows.map(r=>r.functionName),[
    'spawn','execFileSync','execFile','fork','spawnSync','spawn',
  ]);
  assert.equal(rows.every(row=>row.file==='src/agent/fixture.ts'),true);
  assert.equal(rows[0]?.line,5);
  assert.deepEqual(countSignatures(rows),{
    'src/agent/fixture.ts#execFile':1,
    'src/agent/fixture.ts#execFileSync':1,
    'src/agent/fixture.ts#fork':1,
    'src/agent/fixture.ts#spawn':2,
    'src/agent/fixture.ts#spawnSync':1,
  });
});

test('strings/comments/identically named local functions do not masquerade as imported launch calls',()=>{
  const code=[
    "const raw = `const {spawn}=require('child_process'); spawn('bad')`;",
    "// import {spawn} from 'child_process'; spawn('bad');",
    "function spawn(x:string){return x;}",
    "spawn('safe');",
    "const notCP={spawn(){return 1}};notCP.spawn();",
  ].join('\n');
  assert.deepEqual(scanNativeLaunches('src/mock.ts',code),[]);
});

test('launch sink baseline flags added callsites and new source files but permits removal',()=>{
  const baseline={'src/agent/example.ts#spawn':1};
  assert.deepEqual(compareLaunchInventory(baseline,baseline).unexpected,[]);
  const increased=compareLaunchInventory(baseline,{
    'src/agent/example.ts#spawn':2,
    'src/new-entry.ts#execFile':1,
  });
  assert.deepEqual(increased.unexpected,[
    {signature:'src/agent/example.ts#spawn',found:2,approved:1},
    {signature:'src/new-entry.ts#execFile',found:1,approved:0},
  ]);
  const reduction=compareLaunchInventory(baseline,{});
  assert.deepEqual(reduction.unexpected,[]);
  assert.deepEqual(reduction.removed,[
    {signature:'src/agent/example.ts#spawn',found:0,approved:1},
  ]);
});

test('current native launch callsites do not exceed explicit main baseline',async()=>{
  const root=process.cwd();
  const manifest=JSON.parse(await fs.readFile(path.join(root,
    'scripts/ai-screen-launch-sinks-baseline.json'),'utf8')) as{
      observedAtBaseline:Record<string,number>;
    };
  const found=countSignatures(await collectNativeLaunches(root));
  const audit=compareLaunchInventory(manifest.observedAtBaseline,found);
  assert.deepEqual(audit.unexpected,[]);
});
