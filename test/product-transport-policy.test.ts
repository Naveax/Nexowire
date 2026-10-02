import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectZeroOwnerSpendTransport,
} from '../src/product/transport-policy.js';

const none = {
  directAvailable: false,
  userHostedAvailable: false,
  sharedFreeRelayAvailable: false,
  prepaidRelayAvailable: false,
  prepaidRelayCredits: 0,
};

test('transport policy always prefers direct data plane', () => {
  assert.deepEqual(
    selectZeroOwnerSpendTransport({
      ...none,
      directAvailable: true,
      userHostedAvailable: true,
      sharedFreeRelayAvailable: true,
      prepaidRelayAvailable: true,
      prepaidRelayCredits: 100,
    }),
    {
      allowed: true,
      route: 'direct',
      denialReason: null,
    },
  );
});

test('user-owned transport beats shared infrastructure', () => {
  assert.equal(
    selectZeroOwnerSpendTransport({
      ...none,
      userHostedAvailable: true,
      sharedFreeRelayAvailable: true,
    }).route,
    'user-hosted',
  );
});

test('shared free relay is allowed while free capacity exists', () => {
  assert.equal(
    selectZeroOwnerSpendTransport({
      ...none,
      sharedFreeRelayAvailable: true,
    }).route,
    'shared-free-relay',
  );
});

test('paid relay is allowed only against prepaid credits', () => {
  assert.deepEqual(
    selectZeroOwnerSpendTransport({
      ...none,
      prepaidRelayAvailable: true,
      prepaidRelayCredits: 1,
    }),
    {
      allowed: true,
      route: 'prepaid-relay',
      denialReason: null,
    },
  );

  assert.deepEqual(
    selectZeroOwnerSpendTransport({
      ...none,
      prepaidRelayAvailable: true,
      prepaidRelayCredits: 0,
    }),
    {
      allowed: false,
      route: null,
      denialReason: 'no-zero-owner-spend-route',
    },
  );
});

test('no route fails closed instead of spending owner money', () => {
  assert.deepEqual(selectZeroOwnerSpendTransport(none), {
    allowed: false,
    route: null,
    denialReason: 'no-zero-owner-spend-route',
  });
});
