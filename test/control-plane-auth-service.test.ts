import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';

test('external identity login creates one free account and reuses it', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  });

  const first = await service.loginExternalIdentity({
    provider: 'github',
    subject: '123',
    displayName: 'Naveax',
  });
  const second = await service.loginExternalIdentity({
    provider: 'github',
    subject: '123',
    displayName: 'Naveax Updated',
  });

  assert.equal(first.account.id, second.account.id);
  assert.equal(first.account.planId, 'free');
  assert.equal((await store.listAccounts()).length, 1);
  assert.equal(second.identity.displayName, 'Naveax Updated');
});
