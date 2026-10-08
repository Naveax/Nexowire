import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsProgramDataAclArguments } from '../src/security/windows-programdata-acl.js';

test('ProgramData directory grants only SYSTEM and Administrators with inheritance', () => {
  const args = windowsProgramDataAclArguments('C:\\ProgramData\\Nexowire\\hub-boot', true);
  assert.ok(args.includes('*S-1-5-18:(OI)(CI)F'));
  assert.ok(args.includes('*S-1-5-32-544:(OI)(CI)F'));
  assert.ok(args.includes('/inheritance:r'));
  assert.ok(args.includes('/remove:g'));
  assert.ok(args.includes('*S-1-5-32-545'));
  assert.equal(args.some((arg) => /^\/t$/i.test(arg)), false);
});

test('ProgramData child files get explicit ACL entries instead of recursive inheritance removal', () => {
  const args = windowsProgramDataAclArguments('C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1', false);
  assert.ok(args.includes('*S-1-5-18:F'));
  assert.ok(args.includes('*S-1-5-32-544:F'));
  assert.equal(args.some((arg) => arg.includes('(OI)') || arg.includes('(CI)')), false);
  assert.equal(args.some((arg) => /^\/t$/i.test(arg)), false);
});
