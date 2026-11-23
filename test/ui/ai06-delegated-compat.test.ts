import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// The legacy npm test shell glob omits nested delegated paths. Keep these
// UI-only pairing and recovery contracts in the standard Node22/24 check,
// without replaying any real pairing request or loading production devices.
test('AI-06: nested connect-state and pairing recovery contracts execute on current source',()=>{
  const selected=[
    'test/delegated/k01/connect-state.test.ts',
    'test/delegated/k06/connect-error-display.test.mjs',
    'test/delegated/k06/p005-pairing-recovery.test.mjs',
    'test/connect-web.test.ts',
  ];
  // Child test discovery needs a fresh runner context; inheriting this value
  // makes Node incorrectly skip the nested test invocation.
  const env:NodeJS.ProcessEnv={...process.env,CI:'true'};
  delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,
    ['--test','--test-reporter=tap','--import','tsx','--test-concurrency=1',...selected],{
      cwd:process.cwd(),env,encoding:'utf8',timeout:60_000,
      maxBuffer:3*1024*1024,
    });
  const output=child.stdout??'';
  const failed=[...output.matchAll(/^not ok\s+\d+.*$/gm)]
    .map(m=>output.slice(m.index??0,(m.index??0)+1100)).slice(0,5);
  const summary=output.split('\n')
    .filter(line=>/^# (?:tests|pass|fail|cancelled|skipped|todo)\s/.test(line))
    .join(' / ');
  const diagnostic='selected='+selected.length+' exit='+child.status+
    ' summary='+summary+' failures='+failed.join('\n')+
    ' stderr='+(child.stderr??'').slice(-700);
  assert.equal(child.error,undefined,String(child.error));
  assert.equal(child.signal,null,diagnostic);
  assert.equal(child.status,0,diagnostic);
  assert.match(output,/(?:^|\n)# fail 0(?:\r?\n|$)/,diagnostic);
  const count=Number(output.match(/(?:^|\n)# tests (\d+)/)?.[1]??0);
  assert.ok(count>=30,'AI-06 nested tests omitted: '+diagnostic);
});
