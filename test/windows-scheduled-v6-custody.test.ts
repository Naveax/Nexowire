import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('native supervisor custody candidate is read-only and does not introduce a launch sink',()=>{
  const s=readFileSync(new URL('../native/windows-scheduled-v6-custody.c',import.meta.url),'utf8');
  assert.match(s,/GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING/);
  assert.match(s,/FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(s,/info\.nNumberOfLinks!=1/);
  assert.match(s,/FileIdInfo/);
  assert.match(s,/BCryptHashData/);
  assert.match(s,/CreatePipe\(&c\.read_end,&c\.write_end,NULL,4096\)/);
  assert.match(s,/HANDLE_FLAG_INHERIT/);
  assert.match(s,/now-assignment_tick<NX_NATIVE_GATE_MS/);
  assert.match(s,/NOT a unique boot epoch/);
  assert.doesNotMatch(s,/\b(?:CreateProcessW|ResumeThread|DuplicateHandle|CreateNamedPipeW|WriteFile)\s*\(/);
});
