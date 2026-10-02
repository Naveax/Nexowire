import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import { ControlPlaneService } from '../src/product/control-plane-service.js';
import {
  githubOAuthCallback,
  githubOAuthStart,
} from '../src/product/github-oauth.js';

const secret = '0123456789abcdef0123456789abcdef';

test('github oauth start emits authorize redirect with signed state', () => {
  const response = githubOAuthStart(
    new Request('https://nexowire.example/auth/github/start?next=/dashboard'),
    {
      clientId: 'client-id',
      clientSecret: 'secret',
      sessionSecret: secret,
    },
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location')!);
  assert.equal(location.origin, 'https://github.com');
  assert.equal(location.pathname, '/login/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.ok(location.searchParams.get('state'));
});

test('github oauth callback validates identity and issues session cookie', async () => {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  });

  const start = githubOAuthStart(
    new Request('https://nexowire.example/auth/github/start?next=/dashboard'),
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      sessionSecret: secret,
    },
  );
  const state = new URL(
    start.headers.get('location')!,
  ).searchParams.get('state')!;

  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    const url = String(input);
    if (url.includes('/login/oauth/access_token')) {
      return Response.json({ access_token: 'gho_test' });
    }
    if (url === 'https://api.github.com/user') {
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer gho_test',
      );
      return Response.json({
        id: 79841922,
        login: 'Naveax',
        name: 'Naveax',
        email: null,
      });
    }
    throw new Error('Unexpected fetch: ' + url);
  };

  const callback = await githubOAuthCallback(
    new Request(
      'https://nexowire.example/auth/github/callback?code=abc&state=' +
        encodeURIComponent(state),
    ),
    service,
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      sessionSecret: secret,
      adminGitHubId: '79841922',
      fetchImpl,
    },
  );

  assert.equal(calls, 2);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/dashboard');
  assert.match(
    callback.headers.get('set-cookie') ?? '',
    /^nwx_session=/,
  );

  const accounts = await store.listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.admin, true);
});
