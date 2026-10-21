import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DurableTransferContinuity,
  type TransferCheckpoint, type TransferCheckpointStore,
  type TransferBinding,
} from '../src/mcp/cross-device-transfer-continuity.js';
import {
  ownerGrantEpochGuard, type TransferGrantFence,
  type CurrentAuthenticatedTransferGrant,
} from '../src/mcp/cross-device-transfer-owner-grant.js';

const bytes = Buffer.alloc(65536, 0x5a);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const binding = (): TransferBinding => ({
  jobId: randomUUID(), ownerId: 'owner-A', projectId: 'project-A',
  sourceDeviceId: 'workpc-test', destinationDeviceId: 'naveax-test',
  sourcePath: '/sandbox/source', targetPath: '/sandbox/target',
  stagePath: '/sandbox/target.stage', sourceSha256: sha256(bytes),
  totalBytes: bytes.length,
});
const route = (epoch = 1) => ({
  ownerId: 'owner-A', projectId: 'project-A',
  sourceDeviceId: 'workpc-test', destinationDeviceId: 'naveax-test', epoch,
});
const expected = (mode: TransferGrantFence['mode']): TransferGrantFence => ({
  ...route(), grantEpoch: 71, mode,
});
const grant = (mode: TransferGrantFence['mode']): CurrentAuthenticatedTransferGrant => ({
  ...route(), grantEpoch: 71, enabled: true, revoked: false,
  brokerAttested: mode !== 'standard', mode,
});

class DurableSQLite implements TransferCheckpointStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cp (job TEXT PRIMARY KEY, revision INTEGER, val TEXT NOT NULL)');
  }
  async insert(row: TransferCheckpoint) {
    return this.db.prepare('INSERT OR IGNORE INTO cp(job,revision,val) VALUES (?,?,?)')
      .run(row.binding.jobId, row.revision, JSON.stringify(row)).changes === 1;
  }
  async read(id: string): Promise<TransferCheckpoint | undefined> {
    const row = this.db.prepare('SELECT val FROM cp WHERE job=?').get(id) as
      {val:string} | undefined;
    return row ? JSON.parse(row.val) as TransferCheckpoint : undefined;
  }
  async compareAndSwap(id: string, old: number, row: TransferCheckpoint) {
    return this.db.prepare('UPDATE cp SET revision=?, val=? WHERE job=? AND revision=?')
      .run(row.revision, JSON.stringify(row), id, old).changes === 1;
  }
  close() { this.db.close(); }
}

async function scenario(
  t: import('node:test').TestContext,
  mode: TransferGrantFence['mode'] = 'standard',
  readback?: (
    revoke: () => void
  ) => Promise<'correct' | 'partial' | 'wrong'>,
  root?: {epoch: number; expiresAt: string},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-06-owner-grant-'));
  const instances: DurableSQLite[] = [];
  const reopen = () => {
    const x = new DurableSQLite(path.join(dir, 'cp.sqlite'));
    instances.push(x);
    return x;
  };
  t.after(async () => {
    for (const x of instances) x.close();
    await fs.rm(dir, {recursive: true, force: true});
  });
  const b = binding();
  let g = grant(mode);
  if (root) g = {...g, rootEpoch:root.epoch, rootExpiresAt:root.expiresAt};
  const adm: TransferGrantFence = {...expected(mode),
    ...(root ? {rootEpoch:root.epoch,rootExpiresAt:root.expiresAt} : {})};
  const authorize = ownerGrantEpochGuard(adm, { current: async () => g },
    () => Date.parse('2026-10-21T13:00:00.000Z'));
  const rv = () => { g = { ...g, revoked: true, grantEpoch: 72 }; };
  const c = new DurableTransferContinuity(
    reopen(), async (ident, chunk) => {
      const state = await readback?.(rv) ?? 'correct';
      return state === 'partial' ? {kind:'partial'} as const :
        {kind:'verified' as const, deviceId:ident.destinationDeviceId,
          offset:chunk.offset, length:chunk.length,
          sha256:state==='wrong' ? 'f'.repeat(64) : sha256(bytes)};
    }, undefined, authorize,
  );
  return {
    b, c, reopen, rv, getGrant:()=>g,
    update: (next: CurrentAuthenticatedTransferGrant)=>{g = next;},
    auth:authorize,
  };
}

test('CORE revoked after persisted reservation: never credits ACK, never advances independently readbacked prefix', async t => {
  const s = await scenario(t, 'core', async revoke => { revoke(); return 'correct'; });
  await s.c.create(s.b, route());
  const row = await s.c.reserveWrite({
    jobId:s.b.jobId,route:route(),offset:0,length:bytes.length,sha256:sha256(bytes),
  });
  assert.equal(row.status,'awaiting_ack');
  await assert.rejects(s.c.reconcilePending(s.b.jobId,route()),
    {code:'TRANSFER_ACCESS_REVOKED'});
  // Restoring current authority for READ-ONLY inspection must show no CAS
  // commit of an unverified/revoked response.
  s.update({...grant('core')});
  assert.equal((await s.c.inspect(s.b.jobId,route())).offset,0);
  s.rv();
  await assert.rejects(s.c.observeAck({
    jobId:s.b.jobId,route:route(),requestId:row.pending!.requestId,
    offset:0,sha256:sha256(bytes),
  }),{code:'TRANSFER_ACCESS_REVOKED'});
  await assert.rejects(s.c.reserveWrite({
    jobId:s.b.jobId,route:route(),offset:0,length:bytes.length,sha256:sha256(bytes),
  }),{code:'TRANSFER_ACCESS_REVOKED'});
});

test('CORE preference alone never authorizes an elevated Broker operation', async t => {
  const s=await scenario(t,'core');
  s.update({...s.getGrant(),brokerAttested:false});
  await assert.rejects(s.c.create(s.b,route()),{code:'TRANSFER_ACCESS_REVOKED'});
  // No checkpoint is reserved in the durable database.
  assert.equal(await s.reopen().read(s.b.jobId),undefined);
});

test('ROOT session generation change, owner grant bump and expiry fence old transfer job', async t => {
  const valid = {epoch:5,expiresAt:'2026-10-21T13:12:00.000Z'};
  const s=await scenario(t,'root',undefined,valid);
  await s.c.create(s.b,route(1));
  const row=await s.c.reserveWrite({
    jobId:s.b.jobId,route:route(1),offset:0,length:bytes.length,
    sha256:sha256(bytes),
  });
  s.update({...s.getGrant(),rootEpoch:6});
  await assert.rejects(s.c.observeAck({
    jobId:s.b.jobId,route:route(1),requestId:row.pending!.requestId,
    offset:0,sha256:sha256(bytes),
  }),{code:'TRANSFER_ACCESS_REVOKED'});
  s.update({...s.getGrant(),rootEpoch:5,grantEpoch:72});
  await assert.rejects(s.c.onReconnect({
    jobId:s.b.jobId,oldRoute:route(1),nextEpoch:2,
  }),{code:'TRANSFER_ACCESS_REVOKED'});
  s.update({...s.getGrant(),grantEpoch:71,
    rootExpiresAt:'2026-10-21T12:59:59.000Z'});
  await assert.rejects(s.c.reconcilePending(s.b.jobId,route(1)),
    {code:'TRANSFER_ACCESS_REVOKED'});
  s.update({...s.getGrant(),rootExpiresAt:valid.expiresAt});
  const persisted = await s.c.inspect(s.b.jobId,route(1));
  assert.equal(persisted.epoch,1);
  assert.equal(persisted.offset,0);
});

test('UNKNOWN mutation never replays under stale destination epoch or cancel; prefix requires exact readback hash',async t=>{
  let state:'partial'|'wrong'|'correct'='partial';
  const s=await scenario(t,'standard',async()=>state);
  await s.c.create(s.b,route(1));
  const row=await s.c.reserveWrite({
    jobId:s.b.jobId,route:route(1),offset:0,length:bytes.length,sha256:sha256(bytes),
  });
  await s.c.onReconnect({jobId:s.b.jobId,oldRoute:route(1),nextEpoch:2});
  await assert.rejects(s.c.observeAck({
    jobId:s.b.jobId,route:route(1),
    requestId:row.pending!.requestId,offset:0,sha256:sha256(bytes),
  }),{code:'TRANSFER_EPOCH_STALE'});
  const unknown=await s.c.reconcilePending(s.b.jobId,route(2));
  assert.equal(unknown.status,'unknown');
  state='wrong';
  assert.equal((await s.c.reconcilePending(s.b.jobId,route(2))).offset,0);
  await assert.rejects(s.c.reserveWrite({
    jobId:s.b.jobId,route:route(2),offset:0,length:bytes.length,sha256:sha256(bytes),
  }),{code:'TRANSFER_NOT_DISPATCHABLE'});
  const cancelled=await s.c.cancel(s.b.jobId,route(2));
  assert.equal(cancelled.status,'cancel_pending');
  state='correct';
  await assert.rejects(s.c.reconcilePending(s.b.jobId,route(2)),
    {code:'TRANSFER_NOT_RECONCILABLE'});
  assert.equal((await s.c.inspect(s.b.jobId,route(2))).offset,0);
});

test('project/device mismatch and absence of independent owner authority fail closed',async t=>{
  const s=await scenario(t,'standard');
  await s.c.create(s.b,route());
  await assert.rejects(s.c.inspect(s.b.jobId,{...route(),projectId:'foreign'}),
    {code:'TRANSFER_ROUTE_DENIED'});
  await assert.rejects(s.c.inspect(s.b.jobId,{...route(),destinationDeviceId:'other'}),
    {code:'TRANSFER_ROUTE_DENIED'});
  const missing=ownerGrantEpochGuard(expected('standard'),undefined);
  assert.equal(await missing(route(),s.b),false);
  s.update({...s.getGrant(),enabled:false});
  await assert.rejects(s.c.cancel(s.b.jobId,route()),
    {code:'TRANSFER_ACCESS_REVOKED'});
});
