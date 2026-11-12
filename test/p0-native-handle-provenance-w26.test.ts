import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// W26 independent acceptance oracle: never modifies #05/#08 production code.
// Every real filesystem object is created below a unique disposable TEMP root.
const WINDOWS_ONLY = process.platform === 'win32' ? false : 'requires Windows native handles';
const CHUNK = 64 * 1024;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function disposable(t: import('node:test').TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w26-handle-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

// Read-attributes-only kernel32 probe, deliberately not a privileged writer.
const nativeCSharp = [
  'using System;',
  'using System.IO;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class NxW26Probe {',
  ' [StructLayout(LayoutKind.Sequential)] public struct FT { public uint lo,hi; }',
  ' [StructLayout(LayoutKind.Sequential)] public struct INFO {',
  '  public uint attrs; public FT c,a,w;',
  '  public uint volume,sizeHi,sizeLo,links,indexHi,indexLo; }',
  ' [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern SafeFileHandle Open(string p,uint access,uint share,IntPtr sa,uint mode,uint flags,IntPtr template);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandle",SetLastError=true)]',
  ' static extern bool Info(SafeFileHandle h,out INFO i);',
  ' [DllImport("kernel32.dll",EntryPoint="GetFinalPathNameByHandleW",CharSet=CharSet.Unicode,SetLastError=true)]',
  ' static extern uint Final(SafeFileHandle h,StringBuilder b,uint capacity,uint flags);',
  ' static SafeFileHandle OpenAttributes(string p) {',
  '  var h=Open(p,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);',
  '  if(h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '  return h;',
  ' }',
  ' static INFO Get(SafeFileHandle h) {',
  '  INFO i; if(!Info(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error()); return i;',
  ' }',
  ' static string Identity(INFO i) {',
  '  return i.volume.ToString("X8")+":"+i.indexHi.ToString("X8")+":"+i.indexLo.ToString("X8");',
  ' }',
  ' public static string[] Inspect(string p) {',
  '  using(var h=OpenAttributes(p)) {',
  '   var i=Get(h); var b=new StringBuilder(32768);',
  '   var n=Final(h,b,(uint)b.Capacity,0);',
  '   if(n==0||n>=(uint)b.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '   return new string[]{Identity(i),i.links.ToString(),(i.attrs&0x400)!=0?"REPARSE":"REGULAR",b.ToString()};',
  '  }',
  ' }',
  ' public static string[] HoldAcrossRename(string original,string renamed) {',
  '  using(var h=OpenAttributes(original)) {',
  '   var before=Identity(Get(h));',
  '   File.Move(original,renamed);',
  '   File.WriteAllBytes(original,new byte[]{0x42,0x41,0x44});',
  '   return new string[]{before,Identity(Get(h)),Inspect(original)[0],Inspect(renamed)[0]};',
  '  }',
  ' }',
  '}',
].join('\n');

type NativeInspection = Record<string, string[]>;
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
function inspectNative(expressions: Record<string, string>): NativeInspection {
  const assignments = Object.entries(expressions).map(
    ([key, expr]) => '  ' + key + ' = ' + expr,
  ).join('\n');
  const script = "$ErrorActionPreference='Stop'\n" +
    "Add-Type -TypeDefinition @'\n" + nativeCSharp + "\n'@\n" +
    '$result=[ordered]@{' + '\n' + assignments + '\n}\n' +
    'ConvertTo-Json -InputObject $result -Compress -Depth 6';
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const response = execFileSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 });
  return JSON.parse(response.trim()) as NativeInspection;
}

test('W26 Windows retained handle rejects rename/recreate, hardlink and ADS alias identities',
  { skip: WINDOWS_ONLY, timeout: 60_000 }, async t => {
    const root = await disposable(t);
    const original = path.join(root, 'original.bin');
    const hardlink = path.join(root, 'alias.bin');
    const stream = original + ':w26_test_stream';
    const renamed = path.join(root, 'moved.bin');
    await fs.writeFile(original, 'original-data');
    await fs.link(original, hardlink);
    await fs.writeFile(stream, 'alternate-stream-data');
    const r = inspectNative({
      original: '[NxW26Probe]::Inspect(' + psQuote(original) + ')',
      hardlink: '[NxW26Probe]::Inspect(' + psQuote(hardlink) + ')',
      stream: '[NxW26Probe]::Inspect(' + psQuote(stream) + ')',
      retained: '[NxW26Probe]::HoldAcrossRename(' + psQuote(original) + ',' + psQuote(renamed) + ')',
    });
    assert.equal(r.original?.[0], r.hardlink?.[0], 'hardlinks share a file ID');
    assert.ok(Number(r.original?.[1]) >= 2, 'hardlink count is visible');
    assert.equal(r.original?.[0], r.stream?.[0], 'ADS does not create a new file ID');
    assert.notEqual(r.original?.[3], r.stream?.[3], 'ADS is a distinct stream path');
    assert.equal(r.original?.[0], r.retained?.[0]);
    assert.equal(r.retained?.[0], r.retained?.[1], 'open handle remains pinned');
    assert.equal(r.retained?.[1], r.retained?.[3], 'renamed file is pinned object');
    assert.notEqual(r.retained?.[1], r.retained?.[2], 'recreated pathname is not pinned object');
    assert.equal(await fs.readFile(original, 'utf8'), 'BAD');
    assert.equal(await fs.readFile(renamed, 'utf8'), 'original-data');
    assert.equal(await fs.readFile(hardlink, 'utf8'), 'original-data');
  });

test('W26 Windows OPEN_REPARSE_POINT differentiates junction handle from traversed target',
  { skip: WINDOWS_ONLY, timeout: 60_000 }, async t => {
    const root = await disposable(t);
    const target = path.join(root, 'target');
    const junction = path.join(root, 'junction');
    await fs.mkdir(target);
    const child = path.join(target, 'child.bin');
    await fs.writeFile(child, 'trusted-child');
    try {
      await fs.symlink(target, junction, 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
        t.skip('host cannot create disposable NTFS junction: ' + code);
        return;
      }
      throw error;
    }
    const r = inspectNative({
      junction: '[NxW26Probe]::Inspect(' + psQuote(junction) + ')',
      target: '[NxW26Probe]::Inspect(' + psQuote(target) + ')',
      direct: '[NxW26Probe]::Inspect(' + psQuote(child) + ')',
      traversed: '[NxW26Probe]::Inspect(' + psQuote(path.join(junction, 'child.bin')) + ')',
    });
    assert.equal(r.junction?.[2], 'REPARSE');
    assert.equal(r.target?.[2], 'REGULAR');
    assert.notEqual(r.junction?.[0], r.target?.[0], 'junction and target are different objects');
    assert.equal(r.direct?.[0], r.traversed?.[0], 'traversal reaches same target child');
    assert.notEqual(r.junction?.[0], r.traversed?.[0], 'path ancestry is not handle identity');
  });

type BoundAuthority = Readonly<{
  owner: string; device: string; grantEpoch: bigint; volumeGuid: string;
  diskId: string; partitionId: string; fileId: string; reparse: boolean;
}>;
function authorizePinned(grant: BoundAuthority, observed: BoundAuthority): boolean {
  return grant.owner === observed.owner &&
    grant.device === observed.device &&
    grant.grantEpoch === observed.grantEpoch &&
    grant.volumeGuid.length > 0 && grant.volumeGuid === observed.volumeGuid &&
    grant.diskId.length > 0 && grant.diskId === observed.diskId &&
    grant.partitionId.length > 0 && grant.partitionId === observed.partitionId &&
    grant.fileId.length > 0 && grant.fileId === observed.fileId &&
    !grant.reparse && !observed.reparse;
}

test('W26 synthetic scoped-volume authority denies reletter/replace/reparse/stale grant', () => {
  const approved: BoundAuthority = {
    owner: 'owner-A', device: 'device-A', grantEpoch: 19n,
    volumeGuid: '\\\\?\\Volume{A}\\', diskId: 'disk-A', partitionId: 'part-A',
    fileId: 'F:001', reparse: false,
  };
  assert.equal(authorizePinned(approved, { ...approved }), true);
  for (const changed of [
    { owner: 'owner-B' }, { device: 'device-B' }, { grantEpoch: 18n },
    { volumeGuid: '\\\\?\\Volume{B}\\' }, { diskId: 'disk-B' },
    { partitionId: 'part-B' }, { fileId: 'F:002' }, { reparse: true },
    { volumeGuid: '' }, { diskId: '' }, { partitionId: '' }, { fileId: '' },
  ] satisfies Array<Partial<BoundAuthority>>) {
    assert.equal(authorizePinned(approved, { ...approved, ...changed }), false,
      'changed dimension must fail closed: ' + Object.keys(changed).join(','));
  }
  assert.equal(authorizePinned({ ...approved, reparse: true }, approved), false);
});

// Metadata-only arithmetic. No huge file is allocated, sparse or otherwise.
function boundedOffset(virtualSize: bigint, offset: bigint, requested: bigint):
  { offset: number; length: number } {
  if (virtualSize < 0n || virtualSize > BigInt(Number.MAX_SAFE_INTEGER) ||
    offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    requested < 1n || requested > BigInt(CHUNK) ||
    offset > virtualSize || offset + requested > virtualSize) {
    throw new RangeError('invalid 64-bit-safe byte range');
  }
  return { offset: Number(offset), length: Number(requested) };
}

test('W26 virtual >256MiB and >4GiB offsets preserve 64-bit-safe precision without allocation', () => {
  const limit256 = 256n * 1024n * 1024n;
  assert.deepEqual(boundedOffset(limit256 + 4097n, limit256 + 1n, 4096n),
    { offset: Number(limit256 + 1n), length: 4096 });
  const over4GiB = (1n << 32n) + 1024n;
  assert.deepEqual(boundedOffset(over4GiB + 8192n, over4GiB, 8192n),
    { offset: Number(over4GiB), length: 8192 });
  for (const [size, offset, chunk] of [
    [limit256, limit256 + 1n, 1n],
    [over4GiB, over4GiB - 1n, 2n],
    [over4GiB, -1n, 1n],
    [over4GiB, 0n, BigInt(CHUNK) + 1n],
    [(1n << 53n) + 1n, 0n, 1n],
    [(1n << 53n) + 100n, (1n << 53n) + 1n, 1n],
    [over4GiB, 0n, 0n],
  ] as const) assert.throws(() => boundedOffset(size, offset, chunk), RangeError);
});

async function readWithCancellation(
  handle: fs.FileHandle, signal: AbortSignal, afterFirstChunk: () => Promise<void>,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let position = 0; position < 2 * CHUNK; position += CHUNK) {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    const buffer = Buffer.alloc(CHUNK);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead !== CHUNK) throw new Error('PARTIAL_READBACK');
    parts.push(buffer);
    if (position === 0) await afterFirstChunk();
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  }
  return Buffer.concat(parts);
}

test('W26 deterministic in-flight cancel quarantines partial readback on renamed open handle',
  async t => {
    const root = await disposable(t);
    const source = path.join(root, 'approved.bin');
    const renamed = path.join(root, 'retained.bin');
    const final = path.join(root, 'published.bin');
    const data = Buffer.alloc(2 * CHUNK, 0x5a);
    await fs.writeFile(source, data);
    const handle = await fs.open(source, 'r');
    t.after(async () => { await handle.close(); });
    let enterFirst!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enterFirst = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancellation = new AbortController();
    const read = readWithCancellation(handle, cancellation.signal, async () => {
      enterFirst();
      await gate;
    });
    await entered;
    await fs.rename(source, renamed);
    await fs.writeFile(source, 'replaced-path');
    cancellation.abort();
    release();
    await assert.rejects(read, (error: unknown) =>
      (error as NodeJS.ErrnoException).code === 'CANCELLED');
    await assert.rejects(() => fs.stat(final), { code: 'ENOENT' });
    const originalPrefix = Buffer.alloc(CHUNK);
    const { bytesRead } = await handle.read(originalPrefix, 0, CHUNK, 0);
    assert.equal(bytesRead, CHUNK);
    assert.equal(sha256(originalPrefix), sha256(data.subarray(0, CHUNK)));
    assert.equal(await fs.readFile(source, 'utf8'), 'replaced-path');
    assert.notEqual(sha256(originalPrefix), sha256(Buffer.from('replaced-path')));
  });

test('W26 lost write ACK is UNKNOWN, independently read back, never replay after cancel',
  async t => {
    const root = await disposable(t);
    const stage = path.join(root, 'quarantined.stage');
    const final = path.join(root, 'published.bin');
    const payload = Buffer.from('one-trusted-write-no-blind-replay');
    let physicalWrites = 0;
    let phase: 'PENDING' | 'MUTATION_UNKNOWN' | 'CANCELLED' = 'PENDING';
    async function writeWithLostAck() {
      physicalWrites++;
      await fs.writeFile(stage, payload);
      throw new Error('ACK_LOST_AFTER_WRITE');
    }
    await assert.rejects(writeWithLostAck, /ACK_LOST_AFTER_WRITE/);
    phase = 'MUTATION_UNKNOWN';
    assert.equal(phase, 'MUTATION_UNKNOWN');
    const independentlyRead = await fs.readFile(stage);
    assert.equal(sha256(independentlyRead), sha256(payload));
    assert.notEqual(sha256(Buffer.from('forged-receipt')), sha256(independentlyRead));
    phase = 'CANCELLED';
    assert.equal(phase, 'CANCELLED');
    assert.equal(physicalWrites, 1, 'cancel does not replay an uncertain write');
    await assert.rejects(() => fs.stat(final), { code: 'ENOENT' });
  });
