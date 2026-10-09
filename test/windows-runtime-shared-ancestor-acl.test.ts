import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {
  assertWindowsPrivilegedRuntimeTrusted,
} from '../src/security/windows-privileged-runtime-trust.js';

test('runtime ACL audit limits common OS ancestors without relaxing installed code',()=>{
  const source=readFileSync(new URL('../src/security/windows-privileged-runtime-trust.ts',import.meta.url),'utf8');
  assert.ok(source.includes('$ancestorMask='));
  assert.ok(source.includes('$protectedTargets=@('));
  assert.ok(source.includes('$sharedAncestor='));
  assert.ok(source.includes('if($sharedAncestor){$effectiveMask=$ancestorMask}'));
  assert.ok(source.includes('PropagationFlags]::InheritOnly'));
  assert.ok(source.includes('if($sharedAncestor -and'));
  assert.ok(source.includes('$mask=([int]$rights::WriteData'));
  assert.ok(source.includes('CheckItem $item.FullName'));
  assert.ok(source.includes("RUNTIME_UNTRUSTED_WRITE_ACE"));
  assert.ok(source.includes("RUNTIME_OWNER_UNTRUSTED"));
});

const trustedNode='C:\\Program Files\\nodejs\\node.exe';
const trustedNpmCli='C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

test('protected Windows Node/npm tree passes trusted signer and ACL audit despite shared system-root inheritable ACEs',{
  skip:process.platform!=='win32'||!existsSync(trustedNode)||!existsSync(trustedNpmCli),
},()=>{
  // Uses already installed signed Node/npm: completely read-only, with no ACL
  // mutation. Full code tree and ancestors are inspected as in production.
  assert.doesNotThrow(()=>assertWindowsPrivilegedRuntimeTrusted({
    executable:trustedNode,
    cliEntrypoint:trustedNpmCli,
  }));
});
