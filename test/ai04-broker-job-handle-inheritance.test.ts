import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// AI-04 static contract only. Real handles and descendant isolation still need
// Windows kernel tests and cannot be accepted on the strength of this fixture.
const source=readFileSync(new URL('../native/windows-job-owner.c',
  import.meta.url),'utf8');

test('AI-04 Job root uses explicit standard-handle-only inheritance list',()=>{
  assert.match(source,/PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(source,/UpdateProcThreadAttribute\(attrs,0,/);
  assert.match(source,/sizeof\(inheritedStdio\)/);
  assert.match(source,/DuplicateHandle\(GetCurrentProcess\(\),originalStdio\[i\]/);
  assert.match(source,/GetCurrentProcess\(\),&inheritedStdio\[i\],0,TRUE,DUPLICATE_SAME_ACCESS/);
  assert.match(source,/CreateProcessW\(NULL,cmd,NULL,NULL,TRUE,\s*CREATE_SUSPENDED\|CREATE_NO_WINDOW\|EXTENDED_STARTUPINFO_PRESENT/);
  assert.doesNotMatch(source,/STARTUPINFOW si=\{0\}/,
    'bare STARTUPINFOW with broad handle inheritance must remain banned');
});

test('AI-04 Job root fails closed on allowlist setup errors and cleans handles',()=>{
  assert.match(source,/if\(!originalStdio\[i\] \|\| originalStdio\[i\]==INVALID_HANDLE_VALUE/);
  assert.match(source,/InitializeProcThreadAttributeList\(NULL,1,0,&attrsSize\)/);
  assert.match(source,/if\(!attrs \|\| !InitializeProcThreadAttributeList/);
  assert.match(source,/if\(canLaunch && !UpdateProcThreadAttribute/);
  assert.match(source,/if\(canLaunch\)\{\s*created=CreateProcessW/);
  assert.match(source,/if\(attrsReady\)DeleteProcThreadAttributeList\(attrs\)/);
  assert.match(source,/for\(int i=0;i<3;i\+\+\)if\(inheritedStdio\[i\]\)CloseHandle\(inheritedStdio\[i\]\)/);
  assert.match(source,/if\(!created\)\{\s*diagnostic\(L"create_process_restricted_inheritance"\)/);
  assert.doesNotMatch(source,/if\(!canLaunch\).*CreateProcessW\(/,
    'attribute-list failure must never fall back to unrestricted inheritance');
});
