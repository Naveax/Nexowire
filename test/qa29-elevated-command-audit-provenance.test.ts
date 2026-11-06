/**
 * #29: synthetic-only, independent audit acceptance contract.
 * This file executes NO shell, Broker, UAC, service, VM or native-agent code.
 * HMAC keys and the monotonic witness are DISPOSABLE FIXTURE substitutes,
 * never production Authenticode/DPAPI/external CAS authorities.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

type Role = 'authority' | 'local_approval' | 'windows_kernel' | 'pipe_capture' | 'readback' | 'transport';
type Kind = 'reserve' | 'approved' | 'token_attested' | 'launch' | 'stdout' | 'stderr' | 'exit' | 'postcondition' | 'ack' | 'unknown' | 'revoke';
type Verdict = 'succeeded' | 'failed' | 'unknown';
type Context = {
  requestId: string; ownerId: string; deviceId: string; sessionId: string;
  ownerEpoch: number; coreEpoch: number; mode: 'CORE' | 'ROOT'; requestExpiresMs: number;
};
type Entry = {seq: number; previous: string; context: Context; role: Role; kind: Kind; data: Record<string, unknown>; mac: string};
type Anchor = {seq: number; digest: string; mac: string};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const roles: Record<Kind, Role> = {
  reserve: 'authority', approved: 'local_approval', token_attested: 'windows_kernel',
  launch: 'windows_kernel', stdout: 'pipe_capture', stderr: 'pipe_capture',
  exit: 'windows_kernel', postcondition: 'readback', ack: 'transport',
  unknown: 'authority', revoke: 'authority',
};
const fields: Record<Kind, readonly string[]> = {
  reserve: ['counter'], approved: ['method', 'receiptId'],
  token_attested: ['integrity', 'adminsEnabled', 'brokerImage', 'publisher', 'aclProtected', 'pid', 'startFiletime'],
  launch: ['pid', 'startFiletime', 'commandRef'],
  stdout: ['digest', 'bytes', 'complete', 'pid', 'startFiletime'],
  stderr: ['digest', 'bytes', 'complete', 'pid', 'startFiletime'],
  exit: ['code', 'timedOut', 'pid', 'startFiletime'],
  postcondition: ['verified', 'independent', 'observedDigest', 'expectedDigest', 'pid', 'startFiletime'],
  ack: ['received'], unknown: ['reason'], revoke: ['newCoreEpoch'],
};
const keys: Record<Role | 'anchor', string> = {
  authority: 'fixture-only-authority-key', local_approval: 'fixture-only-local-consent-key',
  windows_kernel: 'fixture-only-os-probe-key', pipe_capture: 'fixture-only-pipe-key',
  readback: 'fixture-only-independent-readback-key', transport: 'fixture-only-transport-key',
  anchor: 'fixture-only-external-monotonic-anchor-key',
};
const sign = (role: Role | 'anchor', s: string) => createHmac('sha256', keys[role]).update(s).digest('hex');
const digest = (entry: Entry) => sha(JSON.stringify(entry));
const unsigned = (entry: Entry) => JSON.stringify([entry.seq, entry.previous, entry.context, entry.role, entry.kind, entry.data]);
const equalsMac = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) &&
  timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const hex64 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 256;
const validContext = (c: Context, expected: Context, now: number) =>
  JSON.stringify(c) === JSON.stringify(expected) && nonempty(c.requestId) &&
  nonempty(c.ownerId) && nonempty(c.deviceId) && nonempty(c.sessionId) &&
  Number.isSafeInteger(c.ownerEpoch) && c.ownerEpoch > 0 &&
  Number.isSafeInteger(c.coreEpoch) && c.coreEpoch > 0 &&
  (c.mode === 'CORE' || c.mode === 'ROOT') &&
  Number.isSafeInteger(c.requestExpiresMs) && now < c.requestExpiresMs;

/** The external authority's latest value MUST come from outside the rollback domain. */
class SyntheticAudit {
  readonly entries: Entry[] = [];
  readonly context: Context;
  private current: Anchor;
  constructor(context: Context) {
    this.context = context;
    this.current = this.makeAnchor(0, sha('qa29-genesis'));
  }
  private makeAnchor(seq: number, head: string): Anchor {
    return {seq, digest: head, mac: sign('anchor', JSON.stringify([seq, head]))};
  }
  append(kind: Kind, data: Record<string, unknown>, context = this.context): Entry {
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(k => !fields[kind].includes(k))) {
      throw new Error('AUDIT_UNSAFE_OR_UNKNOWN_FIELD');
    }
    // Synthetic reservation fence: never dispatch again after a possible launch,
    // lost ACK or revoke. Production requires an *external* linearizable CAS.
    if (kind === 'launch' && this.entries.some(e =>
      e.kind === 'launch' || e.kind === 'unknown' || e.kind === 'revoke')) {
      throw new Error('AUDIT_REPLAY_FENCED');
    }
    const entry: Entry = {
      seq: this.entries.length + 1, previous: this.current.digest, context,
      role: roles[kind], kind, data: {...data}, mac: '',
    };
    entry.mac = sign(entry.role, unsigned(entry));
    this.entries.push(entry);
    this.current = this.makeAnchor(entry.seq, digest(entry));
    return entry;
  }
  /** Test-only stand-in for an independently durable external CAS read. */
  witness(): Anchor { return {...this.current}; }
}
function verifyChain(entries: readonly Entry[], independentLatest: Anchor, expected: Context, now: number): boolean {
  if (!Number.isSafeInteger(independentLatest.seq) || independentLatest.seq !== entries.length ||
      !hex64(independentLatest.digest) ||
      !equalsMac(independentLatest.mac, sign('anchor', JSON.stringify([independentLatest.seq, independentLatest.digest]))) ||
      entries.length > 64) return false;
  let previous = sha('qa29-genesis');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || !e.context || typeof e.context !== 'object' ||
        !e.data || typeof e.data !== 'object' || Array.isArray(e.data) ||
        e.seq !== i + 1 || e.previous !== previous ||
        roles[e.kind] !== e.role || !fields[e.kind] ||
        Object.keys(e.data).some(k => !fields[e.kind].includes(k)) ||
        !validContext(e.context, expected, now) ||
        !equalsMac(e.mac, sign(e.role, unsigned(e)))) return false;
    previous = digest(e);
  }
  return independentLatest.digest === previous;
}
function classify(entries: readonly Entry[], anchor: Anchor, context: Context, now: number): Verdict {
  if (!verifyChain(entries, anchor, context, now)) return 'unknown';
  const get = (kind: Kind) => entries.filter(e => e.kind === kind);
  const single = (kind: Kind) => get(kind).length === 1 ? get(kind)[0] : undefined;
  const r = single('reserve'), a = single('approved'), t = single('token_attested');
  const l = single('launch'), out = single('stdout'), err = single('stderr');
  const x = single('exit'), p = single('postcondition');
  if (get('revoke').length || get('unknown').length) return 'unknown'; // ACK cannot unstick uncertainty
  if (!r || !a || !t || !l) return 'unknown'; // absence of proof is not proof of no dispatch
  const order = [r, a, t, l, out, err, x, p].filter((e): e is Entry => Boolean(e)).map(e => e.seq);
  if (order.some((n, i) => i > 0 && n <= order[i - 1]!)) return 'unknown';
  const matchProcess = (e: Entry | undefined) =>
    Boolean(e && e.data.pid === t.data.pid && e.data.startFiletime === t.data.startFiletime);
  const trusted = Number.isSafeInteger(r.data.counter) && (r.data.counter as number) > 0 &&
    a.data.method === 'prior_physical_local_enrollment' && nonempty(a.data.receiptId) &&
    t.data.integrity === 'high' && t.data.adminsEnabled === true &&
    t.data.brokerImage === PINNED_IMAGE && t.data.publisher === PINNED_PUBLISHER &&
    t.data.aclProtected === true && Number.isSafeInteger(t.data.pid) &&
    nonempty(t.data.startFiletime) && matchProcess(l) && hex64(l.data.commandRef);
  if (!trusted) return 'unknown'; // launch may have happened despite lost/untrusted proof
  if (!out || !err || !x || !p) return 'unknown';
  const streamValid = [out, err].every(e => matchProcess(e) && hex64(e.data.digest) &&
    Number.isSafeInteger(e.data.bytes) && (e.data.bytes as number) >= 0 &&
    e.data.complete === true);
  if (!streamValid || !matchProcess(x) || !matchProcess(p) ||
      !Number.isSafeInteger(x.data.code) || x.data.timedOut !== false ||
      p.data.independent !== true || !hex64(p.data.observedDigest) ||
      !hex64(p.data.expectedDigest)) return 'unknown';
  if (x.data.code !== 0 || p.data.verified === false ||
      p.data.observedDigest !== p.data.expectedDigest) return 'failed';
  return p.data.verified === true ? 'succeeded' : 'unknown';
}
const PINNED_IMAGE = sha('expected-signed-broker-image'), PINNED_PUBLISHER = sha('externally-pinned-publisher');
const ctx: Context = {
  requestId: '123e4567-e89b-42d3-a456-426614174029',
  ownerId: 'owner-a', deviceId: 'device-a', sessionId: 'session-a',
  ownerEpoch: 8, coreEpoch: 4, mode: 'CORE', requestExpiresMs: 1_800_000_100_000,
};
const NOW = 1_800_000_000_000;
function example() {
  const q = new SyntheticAudit(ctx);
  q.append('reserve', {counter: 81});
  q.append('approved', {method: 'prior_physical_local_enrollment', receiptId: 'trusted-fixture-local-enrollment'});
  const proc = {pid: 2719, startFiletime: '133800000000000001'};
  q.append('token_attested', {...proc, integrity: 'high', adminsEnabled: true,
    brokerImage: PINNED_IMAGE, publisher: PINNED_PUBLISHER, aclProtected: true});
  q.append('launch', {...proc, commandRef: sha('opaque-authorized-command-reference')});
  q.append('stdout', {...proc, digest: sha('bounded stdout'), bytes: 14, complete: true});
  q.append('stderr', {...proc, digest: sha(''), bytes: 0, complete: true});
  q.append('exit', {...proc, code: 0, timedOut: false});
  q.append('postcondition', {...proc, independent: true, verified: true,
    observedDigest: sha('independent observed state'), expectedDigest: sha('independent observed state')});
  return q;
}
test('source fixture proves positive only with pinned high-token launch, both captured streams, exit and independent readback', () => {
  const q = example();
  assert.equal(classify(q.entries, q.witness(), ctx, NOW), 'succeeded');
});
test('forged result and request body cannot manufacture independent postcondition', () => {
  const q = example(), trusted = q.witness();
  q.entries.at(-1)!.data.verified = true;
  q.entries.at(-1)!.data.observedDigest = sha('attacker asserted success');
  assert.equal(classify(q.entries, trusted, ctx, NOW), 'unknown');
});
test('postcondition mismatch beats exit code zero and transport ACK', () => {
  const q = example();
  q.entries.pop(); // intentionally rebuild from independent synthetic signer, not production tampering
  const other = new SyntheticAudit(ctx);
  for (const e of q.entries) other.append(e.kind, e.data);
  other.append('postcondition', {pid: 2719,
    startFiletime: '133800000000000001', independent: true, verified: true,
    observedDigest: sha('different'), expectedDigest: sha('independent observed state')});
  other.append('ack', {received: true});
  assert.equal(classify(other.entries, other.witness(), ctx, NOW), 'failed');
});
test('removed tail and restored local journal reject fresh external monotonic witness', () => {
  const q = example(), currentAnchor = q.witness();
  const restoredSnapshot = q.entries.slice(0, 5);
  assert.equal(classify(restoredSnapshot, currentAnchor, ctx, NOW), 'unknown');
});
test('valid old external witness is not enough against an independently newer witness', () => {
  const q = example(), oldAnchor = q.witness();
  q.append('ack', {received: true});
  assert.equal(classify(q.entries.slice(0, -1), q.witness(), ctx, NOW), 'unknown');
  assert.notDeepEqual(oldAnchor, q.witness());
});
test('duplicate ACKs do not create success without trusted readback', () => {
  const q = new SyntheticAudit(ctx);
  q.append('reserve', {counter: 81});
  q.append('ack', {received: true});
  q.append('ack', {received: true});
  assert.equal(classify(q.entries, q.witness(), ctx, NOW), 'unknown');
});
test('UNKNOWN after possible dispatch is sticky, never upgraded by duplicate ACK', () => {
  const q = example();
  q.append('unknown', {reason: 'ack_lost_after_possible_dispatch'});
  q.append('ack', {received: true});
  q.append('ack', {received: true});
  assert.equal(classify(q.entries, q.witness(), ctx, NOW), 'unknown');
});
test('different requestId or owner/device/session/CORE epoch cannot reuse audit', () => {
  for (const field of ['requestId', 'ownerId', 'deviceId', 'sessionId', 'ownerEpoch', 'coreEpoch'] as const) {
    const q = example(), different = {...ctx, [field]: field.endsWith('Epoch') ? 99 : 'attacker'};
    assert.equal(classify(q.entries, q.witness(), different, NOW), 'unknown', field);
  }
});
test('revocation and stale request expiry fail closed', () => {
  const q = example();
  q.append('revoke', {newCoreEpoch: 5});
  assert.equal(classify(q.entries, q.witness(), ctx, NOW), 'unknown');
  assert.equal(classify(example().entries, example().witness(), ctx, ctx.requestExpiresMs), 'unknown');
});
test('fake high token, publisher, protected ACL, process identity are rejected', () => {
  for (const [kind, field, value] of [
    ['token_attested', 'integrity', 'medium'], ['token_attested', 'adminsEnabled', false],
    ['token_attested', 'publisher', sha('wrong')], ['token_attested', 'aclProtected', false],
    ['launch', 'startFiletime', 'recycled-PID'],
  ] as const) {
    const baseline = example();
    const rebuilt = new SyntheticAudit(ctx);
    for (const e of baseline.entries) rebuilt.append(e.kind, {...e.data, ...(e.kind === kind ? {[field]: value} : {})});
    assert.notEqual(classify(rebuilt.entries, rebuilt.witness(), ctx, NOW), 'succeeded', field);
  }
});
test('missing or partial stdout/stderr/exit/readback never counts as success', () => {
  const full = example();
  for (const lost of ['stdout', 'stderr', 'exit', 'postcondition'] as const) {
    const rebuilt = new SyntheticAudit(ctx);
    for (const e of full.entries) if (e.kind !== lost) rebuilt.append(e.kind, e.data);
    assert.notEqual(classify(rebuilt.entries, rebuilt.witness(), ctx, NOW), 'succeeded', lost);
  }
  const partial = new SyntheticAudit(ctx);
  for (const e of full.entries) partial.append(e.kind, {...e.data, ...(e.kind === 'stdout' ? {complete: false} : {})});
  assert.equal(classify(partial.entries, partial.witness(), ctx, NOW), 'unknown');
});
test('nonzero exit is task failure even when transport succeeded', () => {
  const q = example(), altered = new SyntheticAudit(ctx);
  for (const e of q.entries) altered.append(e.kind, {...e.data, ...(e.kind === 'exit' ? {code: 7} : {})});
  altered.append('ack', {received: true});
  assert.equal(classify(altered.entries, altered.witness(), ctx, NOW), 'failed');
});
test('tampered sequence, linkage, role or payload MAC is never accepted', () => {
  const cases: Array<(e: Entry[]) => void> = [
    e => {e[2]!.seq = 123}, e => {e[3]!.previous = sha('wrong')},
    e => {e[4]!.role = 'transport'}, e => {e[5]!.data.digest = sha('injected')},
  ];
  for (const corrupt of cases) {
    const q = example(), anchor = q.witness();
    corrupt(q.entries);
    assert.equal(classify(q.entries, anchor, ctx, NOW), 'unknown');
  }
});
test('allowlist refuses raw password/token/argv and records only bounded commitment metadata', () => {
  const q = example();
  for (const key of ['password', 'token', 'argv', 'command', 'stdoutRaw', 'stderrRaw']) {
    assert.throws(() => q.append('launch', {[key]: 'SUPER_SECRET_PASSWORD'}), /AUDIT_UNSAFE_OR_UNKNOWN_FIELD/);
  }
  assert.doesNotMatch(JSON.stringify(q.entries), /SUPER_SECRET_PASSWORD|bearer |privateKey|credentialValue/);
});

test('UNKNOWN fences any new synthetic launch, including duplicate after an authenticated launch', () => {
  const q = example();
  q.append('unknown', {reason: 'lost_ack'});
  assert.throws(() => q.append('launch', {
    pid: 2719, startFiletime: '133800000000000001', commandRef: sha('replay'),
  }), /AUDIT_REPLAY_FENCED/);
  assert.equal(classify(q.entries, q.witness(), ctx, NOW), 'unknown');

  const beforeDispatch = new SyntheticAudit(ctx);
  beforeDispatch.append('reserve', {counter: 83});
  beforeDispatch.append('unknown', {reason: 'may_have_dispatched_before_crash'});
  assert.throws(() => beforeDispatch.append('launch', {
    pid: 1, startFiletime: '123', commandRef: sha('late'),
  }), /AUDIT_REPLAY_FENCED/);
});
test('malformed untrusted audit envelope rejects as UNKNOWN rather than throwing', () => {
  for (const corrupt of [
    (e: Entry[]) => {e[0]!.context = null as unknown as Context},
    (e: Entry[]) => {e[2]!.data = null as unknown as Record<string, unknown>},
    (e: Entry[]) => {e[4]!.data = {stdoutRaw: 'SECRET'}},
  ]) {
    const q = example(), w = q.witness();
    corrupt(q.entries);
    assert.doesNotThrow(() => classify(q.entries, w, ctx, NOW));
    assert.equal(classify(q.entries, w, ctx, NOW), 'unknown');
  }
});
