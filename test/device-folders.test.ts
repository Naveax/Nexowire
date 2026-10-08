import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../src/product/control-plane-http.js';

const actor = (accountId: string, role: 'user' | 'service' = 'user') => ({ accountId, role });

test('owner folders persist even when empty and stay account-scoped', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store);
  await service.ensureAccount({ id: 'a' });
  await service.ensureAccount({ id: 'b' });
  async function pair(owner: string, anchor: string) {
    const challenge = await service.beginPairing(actor(owner), 'pc-' + owner);
    return (await service.consumePairing({
      pairingId: challenge.pairingId, token: challenge.token,
      platform: 'win32', deviceAnchorHash: anchor.repeat(64),
    })).device;
  }
  const owned = await pair('a', 'a');
  const foreign = await pair('b', 'b');
  const folder = await service.createDeviceFolder(actor('a'), 'Maxi');
  const empty = await service.createDeviceFolder(actor('a'), 'Naveax');
  await assert.rejects(
    service.createDeviceFolder(actor('a'), 'maxi'), /FOLDER_ALREADY_EXISTS/,
  );
  await assert.rejects(
    service.createDeviceFolder(actor('a'), '   '), /INVALID_FOLDER_NAME/,
  );
  await assert.rejects(
    service.createDeviceFolder(actor('a', 'service'), 'owner-only'), /OWNER_LOGIN_REQUIRED/,
  );
  assert.deepEqual((await service.dashboard(actor('a'))).folders.map(f => f.name).sort(), ['Maxi', 'Naveax']);
  assert.deepEqual((await service.dashboard(actor('b'))).folders, []);

  await assert.rejects(
    service.assignDeviceToFolder(actor('b'), owned.id, folder.id), /DEVICE_NOT_FOUND/,
  );
  await assert.rejects(
    service.assignDeviceToFolder(actor('a'), foreign.id, folder.id), /DEVICE_NOT_FOUND/,
  );
  await assert.rejects(
    service.assignDeviceToFolder(actor('b'), foreign.id, folder.id), /FOLDER_NOT_FOUND/,
  );
  await service.assignDeviceToFolder(actor('a'), owned.id, folder.id);
  assert.equal((await service.dashboard(actor('a'))).devices[0]?.folderId, folder.id);
  assert.equal((await service.dashboard(actor('b'))).devices[0]?.folderId, null);
  await service.deleteDeviceFolder(actor('a'), folder.id);
  assert.equal((await service.dashboard(actor('a'))).devices[0]?.folderId, null);
  assert.equal((await service.dashboard(actor('a'))).folders[0]?.id, empty.id);
});

test('folder mutation HTTP requires owner login and explicit same-origin header', async () => {
  const service = new ControlPlaneService(new MemoryControlPlaneStore());
  await service.ensureAccount({id: 'a'});
  const handler = createControlPlaneHttpHandler(service, {
    authenticate: async req => {
      const accountId = req.headers.get('x-test-account');
      return accountId ? actor(accountId, req.headers.get('x-test-service') ? 'service' : 'user') : null;
    },
  });
  const url = 'https://control.test/api/v1/me/device-folders/create';
  const opts = (extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-test-account': 'a', ...extra},
    body: JSON.stringify({name: 'Naveax'}),
  });
  assert.equal((await handler(new Request(url, opts()))).status, 403);
  assert.equal((await handler(new Request(url, opts({'x-nexowire-confirm':'device-folder-v1'})))).status, 201);
  assert.equal((await handler(new Request(url, opts({'x-nexowire-confirm':'device-folder-v1'})))).status, 409);
  const unauthorized = await handler(new Request(url, {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({name: 'Other'}),
  }));
  assert.equal(unauthorized.status, 401);
  const serviceAccount = await handler(new Request(url, {
    ...opts({'x-nexowire-confirm':'device-folder-v1', 'x-test-service':'yes'}),
    body: JSON.stringify({name:'service-only'}),
  }));
  assert.equal(serviceAccount.status, 403);
});
