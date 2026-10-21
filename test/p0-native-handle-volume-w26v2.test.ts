import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// W26 v2: independent source-only oracle. All actual file operations are
// restricted to a fresh disposable TEMP directory. No user ACL or agent edits.
const windowsOnly = process.platform === 'win32' ? false : 'requires Windows kernel32';
const CHUNK = 64 * 1024;
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function temporary(t: import('node:test').TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w26v2-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// Attributes-only Win32 identity probe. OPEN_REPARSE_POINT prevents following
// the final component. VOLUME_NAME_GUID returns a handle-derived volume path.
const csharp = [
  'using System;',
  'using System.IO;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class NxW26V2 {',
  ' [StructLayout(LayoutKind.Sequential)] public struct FT { public uint low,high; }',
  ' [StructLayout(LayoutKind.Sequential)] public struct INFO {',
  '  public uint attrs; public FT created,accessed,written;',
  '  public uint volume,sizeHi,sizeLo,links,idHi,idLo; }',
  ' [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern SafeFileHandle Open(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandle",SetLastError=true)]',
  ' static extern bool GetInfo(SafeFileHandle handle,out INFO info);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFinalPathNameByHandleW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern uint GetFinal(SafeFileHandle handle,StringBuilder result,uint capacity,uint flags);',
  ' [DllImport("kernel32.dll",EntryPoint="GetVolumePathNameW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern bool GetMount(string path,StringBuilder result,uint size);',
  ' [DllImport("kernel32.dll",EntryPoint="GetVolumeNameForVolumeMountPointW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern bool GetVolume(string path,StringBuilder result,uint size);',
  ' static SafeFileHandle Attributes(string name) {',
  '  var h=Open(name,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);',
  '  if(h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return h;',
  ' }',
  ' static string Identity(SafeFileHandle h) {',
  '  INFO i; if(!GetInfo(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return i.volume.ToString("X8")+":"+i.idHi.ToString("X8")+":"+i.idLo.ToString("X8");',
  ' }',
  ' static string Final(SafeFileHandle h,uint flags) {',
  '  var b=new StringBuilder(32768); uint n=GetFinal(h,b,(uint)b.Capacity,flags);',
  '  if(n==0||n>=(uint)b.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return b.ToString();',
  ' }',
  ' static string MountedVolume(string path) {',
  '  var mount=new StringBuilder(32768); var volume=new StringBuilder(32768);',
  '  if(!GetMount(path,mount,(uint)mount.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  if(!GetVolume(mount.ToString(),volume,(uint)volume.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return volume.ToString();',
  ' }',
  ' public static string[] Inspect(string path) {',
  '  using(var h=Attributes(path)) {',
  '   return new string[]{Identity(h),Final(h,0),Final(h,1),MountedVolume(path)};',
  '  }',
  ' }',
  ' public static string[] RetainRename(string previous,string moved) {',
  '  using(var h=Attributes(previous)) {',
  '   var before=Identity(h); var beforeGuid=Final(h,1);',
  '   File.Move(previous,moved);',
  '   File.WriteAllBytes(previous,new byte[]{0x42,0x41,0x44});',
  '   return new string[]{before,beforeGuid,Identity(h),Final(h,1),',
  '     Inspect(previous)[0],Inspect(previous)[3],Inspect(moved)[0],Inspect(moved)[3]};',
  '  }',
  ' }',
  '}',
].join('\n');

function native(expressions: Record<string, string>): Record<string, string[]> {
  const script = "$ErrorActionPreference='Stop'\n" +
    "Add-Type -TypeDefinition @'\n" + csharp + "\n'@\n" +
    '$v=[ordered]@{' + '\n' +
    Object.entries(expressions).map(([name, expr]) => name + '=' + expr).join('\n') +
    '\n}\nConvertTo-Json -InputObject $v -Depth 7 -Compress';
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const json = execFileSync(exe, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 65536 });
  return JSON.parse(json.trim()) as Record<string, string[]>;
}

function matchingGuid(handleGuidPath: string, mountedVolume: string) {
  return handleGuidPath.toLocaleLowerCase('en-US').startsWith(
    mountedVolume.toLocaleLowerCase('en-US'));
}

test('W26v2 Windows: GetFinalPathNameByHandle GUID volume survives rename, not new path',
  { skip: windowsOnly, timeout: 60000 }, async t => {
    const dir = await temporary(t);
    const ownerApproved = path.join(dir, 'owner-approved');
    const outsideGrant = path.join(dir, 'different-owner-scope');
    await fs.mkdir(ownerApproved);
    await fs.mkdir(outsideGrant);
    const previous = path.join(ownerApproved, 'renamed-source.bin');
    const moved = path.join(outsideGrant, 'renamed-target.bin');
    await fs.writeFile(previous, Buffer.from('original-valid-data'));
    const data = native({
      before: '[NxW26V2]::Inspect(' + q(previous) + ')',
      after: '[NxW26V2]::RetainRename(' + q(previous) + ',' + q(moved) + ')',
      replacement: '[NxW26V2]::Inspect(' + q(previous) + ')',
      moved: '[NxW26V2]::Inspect(' + q(moved) + ')',
    });
    const before = data.before!, held = data.after!, replacement = data.replacement!,
      newName = data.moved!;
    assert.ok(matchingGuid(before[2]!, before[3]!),
      'handle-derived VOLUME_NAME_GUID agrees with OS mount identity');
    assert.ok(matchingGuid(held[3]!, held[7]!));
    assert.equal(before[0], held[0], 'source identity pinned on open');
    assert.equal(held[0], held[2], 'renamed handle identity remains pinned');
    assert.equal(held[2], held[6], 'renamed final object keeps identity');
    assert.notEqual(held[2], held[4], 'replaced original path has new identity');
    assert.equal(replacement[0], held[4]);
    assert.equal(newName[0], held[2]);
    assert.equal(replacement[3]!.toLowerCase(), newName[3]!.toLowerCase());
    assert.notEqual(held[1]!.toLowerCase(), held[3]!.toLowerCase(),
      'final handle GUID path changes on rename');
    // A pinned OS file identity does NOT carry an old user's path permission
    // into a different delegated root after rename.
    const scope: ScopedGrant = {
      owner: 'owner-verified', device: 'device-A', epoch: 39n,
      allowedPath: previous, fileId: before[0]!, volumeGuid: before[3]!,
      stream: null,
    };
    assert.equal(accept(scope, { ...scope }), true);
    assert.equal(accept(scope, { ...scope, allowedPath: moved }), false);
    assert.equal(accept(scope, { ...scope, owner: 'different-owner' }), false);
    assert.equal(accept(scope, { ...scope, epoch: 38n }), false);
    assert.equal(await fs.readFile(previous, 'utf8'), 'BAD');
    assert.equal(await fs.readFile(moved, 'utf8'), 'original-valid-data');
  });

type ScopedGrant = Readonly<{
  owner: string; device: string; epoch: bigint; allowedPath: string;
  fileId: string; volumeGuid: string; stream: string | null;
}>;
function accept(grant: ScopedGrant, observed: ScopedGrant): boolean {
  // This is a test oracle, not an OS ACL decision or authoritative agent.
  return grant.owner === observed.owner && grant.device === observed.device &&
    grant.epoch === observed.epoch &&
    grant.allowedPath.toLowerCase() === observed.allowedPath.toLowerCase() &&
    grant.fileId === observed.fileId &&
    grant.volumeGuid.toLowerCase() === observed.volumeGuid.toLowerCase() &&
    grant.stream === observed.stream && grant.stream === null;
}

test('W26v2 Windows: hardlink/ADS outside delegated pathname cannot reuse file ID as permission',
  { skip: windowsOnly, timeout: 60000 }, async t => {
    const dir = await temporary(t);
    const approved = path.join(dir, 'allowed');
    const outside = path.join(dir, 'not-authorized');
    await fs.mkdir(approved);
    await fs.mkdir(outside);
    const primary = path.join(approved, 'payload.bin');
    const alias = path.join(outside, 'hardlink.bin');
    const ads = primary + ':sensitive_w26v2';
    await fs.writeFile(primary, Buffer.from('approved-stream'));
    await fs.link(primary, alias);
    await fs.writeFile(ads, Buffer.from('other-stream'));
    const result = native({
      primary: '[NxW26V2]::Inspect(' + q(primary) + ')',
      alias: '[NxW26V2]::Inspect(' + q(alias) + ')',
      ads: '[NxW26V2]::Inspect(' + q(ads) + ')',
    });
    const a = result.primary!, b = result.alias!, c = result.ads!;
    assert.equal(a[0], b[0], 'hardlink is same NTFS file');
    assert.equal(a[0], c[0], 'ADS belongs to same NTFS file');
    for (const v of [a, b, c]) assert.ok(matchingGuid(v[2]!, v[3]!));
    assert.equal(a[3]!.toLowerCase(), b[3]!.toLowerCase(),
      'both paths map to same volume even when grant scope differs');
    const grant: ScopedGrant = {
      owner: 'owner-verified', device: 'device-A', epoch: 39n,
      allowedPath: primary, fileId: a[0]!, volumeGuid: a[3]!, stream: null,
    };
    assert.equal(accept(grant, { ...grant }), true);
    assert.equal(accept(grant, { ...grant, allowedPath: alias }), false);
    assert.equal(accept(grant, { ...grant, allowedPath: ads, stream: 'sensitive_w26v2' }), false);
    assert.equal(accept(grant, { ...grant, owner: 'other-user' }), false);
    assert.equal(accept(grant, { ...grant, device: 'other-device' }), false);
    assert.equal(accept(grant, { ...grant, epoch: 38n }), false);
    assert.equal(accept(grant, { ...grant, volumeGuid: '\\\\?\\Volume{swapped}\\' }), false);
    assert.equal(accept(grant, { ...grant, fileId: 'forged-id' }), false);
    assert.equal((await fs.readFile(alias)).toString(), 'approved-stream');
    assert.equal((await fs.readFile(ads)).toString(), 'other-stream');
  });

function safeVirtualRange(size: bigint, offset: bigint, length: bigint) {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (size < 0n || size > max || offset < 0n || offset > max ||
      length < 1n || length > BigInt(CHUNK) ||
      offset > size || length > size - offset) throw new RangeError('INVALID_RANGE');
  return { position: Number(offset), byteCount: Number(length) };
}

test('W26v2 metadata-only 4GiB+ offsets deny u32 wrap, precision loss and bounds', () => {
  const fourGiB = 1n << 32n;
  const size = fourGiB + 65539n;
  assert.deepEqual(safeVirtualRange(size, fourGiB + 3n, 65536n),
    { position: 4_294_967_299, byteCount: CHUNK });
  assert.notEqual(Number(fourGiB + 3n), Number((fourGiB + 3n) & 0xffff_ffffn),
    '32-bit truncation would redirect write/read to the start');
  for (const [s, at, n] of [
    [size, size + 1n, 1n], [size, size - 1n, 2n],
    [size, fourGiB, BigInt(CHUNK) + 1n],
    [size, -1n, 1n], [size, 0n, 0n],
    [(1n << 53n) + 1n, fourGiB, 1n],
    [size, (1n << 53n) + 9n, 1n],
  ] as const) assert.throws(() => safeVirtualRange(s, at, n), RangeError);
  // No >64KiB allocation; all enormous sizes above are BigInt metadata only.
});

async function readExact(handle: fs.FileHandle, bytes: number, signal: AbortSignal,
  afterRead: () => Promise<void>) {
  if (signal.aborted) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
  const buffer = Buffer.alloc(bytes);
  const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
  await afterRead();
  if (signal.aborted) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
  if (bytesRead !== bytes) {
    throw Object.assign(new Error('PARTIAL_READBACK'), { code: 'PARTIAL_READBACK' });
  }
  return buffer;
}

test('W26v2 short-read is not a complete receipt and cannot publish', async t => {
  const dir = await temporary(t);
  const source = path.join(dir, 'short.bin');
  const published = path.join(dir, 'published.bin');
  await fs.writeFile(source, Buffer.from('SHORT'));
  const fd = await fs.open(source, 'r');
  t.after(async () => fd.close());
  await assert.rejects(
    readExact(fd, CHUNK, new AbortController().signal, async () => {}),
    (e: unknown) => (e as NodeJS.ErrnoException).code === 'PARTIAL_READBACK');
  await assert.rejects(fs.stat(published), { code: 'ENOENT' });
  assert.equal(await fs.readFile(source, 'utf8'), 'SHORT');
});

test('W26v2 cancel during gated short-read denies publication and any verified digest', async t => {
  const dir = await temporary(t);
  const source = path.join(dir, 'short-cancel.bin');
  const published = path.join(dir, 'published.bin');
  const payload = Buffer.from('ONLY-SEVEN-TEENS');
  await fs.writeFile(source, payload);
  const fd = await fs.open(source, 'r');
  t.after(async () => fd.close());
  const ac = new AbortController();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let trustedDigest: string | null = null;
  const pending = readExact(fd, CHUNK, ac.signal, async () => {
    entered();
    await gate;
  }).then(data => { trustedDigest = hash(data); return data; });
  await reached;
  ac.abort();
  release();
  await assert.rejects(pending,
    (e: unknown) => (e as NodeJS.ErrnoException).code === 'CANCELLED');
  assert.equal(trustedDigest, null);
  await assert.rejects(fs.stat(published), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(source), payload);
});
