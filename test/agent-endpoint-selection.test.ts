import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentTokenFromEnv,
  parseHubEndpoints,
  planNextHubAttempt,
} from '../src/agent/native-agent.js';

test('hub endpoints default to local native-agent listener', () => {
  assert.deepEqual(parseHubEndpoints({}), [
    'ws://127.0.0.1:43110/agent',
  ]);
});

test('hub endpoints preserve explicit priority and deduplicate normalized URLs', () => {
  assert.deepEqual(
    parseHubEndpoints({
      NEXOWIRE_HUB_WS_URL: 'wss://direct.example/agent',
      NEXOWIRE_HUB_WS_URLS:
        'wss://direct.example/agent, wss://relay.example/agent , ws://10.0.0.8:43110/agent',
    }),
    [
      'wss://direct.example/agent',
      'wss://relay.example/agent',
      'ws://10.0.0.8:43110/agent',
    ],
  );
});

test('hub endpoints reject unsafe or non-WebSocket URL forms', () => {
  for (const value of [
    'https://example.com/agent',
    'file:///tmp/agent',
    'not a url',
    'wss://user:secret@example.com/agent',
    'wss://example.com/agent#fragment',
  ]) {
    assert.throws(() =>
      parseHubEndpoints({
        NEXOWIRE_HUB_WS_URL: value,
      }),
    );
  }
});

test('endpoint selection tries alternates quickly before increasing cycle backoff', () => {
  const afterDirectFailure = planNextHubAttempt({
    currentIndex: 0,
    endpointCount: 2,
    backoffMs: 1_000,
    connectedMs: 0,
    random: () => 0.5,
  });
  assert.deepEqual(afterDirectFailure, {
    endpointIndex: 1,
    waitMs: 250,
    nextBackoffMs: 1_000,
    stableConnection: false,
  });

  const afterRelayFailure = planNextHubAttempt({
    currentIndex: 1,
    endpointCount: 2,
    backoffMs: 1_000,
    connectedMs: 0,
    random: () => 0.5,
  });
  assert.deepEqual(afterRelayFailure, {
    endpointIndex: 0,
    waitMs: 1_000,
    nextBackoffMs: 2_000,
    stableConnection: false,
  });
});

test('stable connection resets backoff and returns to the primary endpoint', () => {
  assert.deepEqual(
    planNextHubAttempt({
      currentIndex: 1,
      endpointCount: 3,
      backoffMs: 16_000,
      connectedMs: 10_000,
      random: () => 0.5,
    }),
    {
      endpointIndex: 0,
      waitMs: 1_000,
      nextBackoffMs: 1_000,
      stableConnection: true,
    },
  );
});

test('single endpoint keeps bounded exponential reconnect behavior', () => {
  assert.deepEqual(
    planNextHubAttempt({
      currentIndex: 0,
      endpointCount: 1,
      backoffMs: 4_000,
      connectedMs: 0,
      random: () => 0.5,
    }),
    {
      endpointIndex: 0,
      waitMs: 4_000,
      nextBackoffMs: 8_000,
      stableConnection: false,
    },
  );

  assert.throws(() =>
    planNextHubAttempt({
      currentIndex: 0,
      endpointCount: 0,
      backoffMs: 1_000,
      connectedMs: 0,
    }),
  );
});

test('native agent token can come from a platform-backed secret reference', () => {
  const token = agentTokenFromEnv(
    {
      NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME: 'agent-primary',
    },
    (name, purpose) => {
      assert.equal(name, 'agent-primary');
      assert.equal(purpose, 'agent-bearer-token');
      return 'platform-agent-token';
    },
  );
  assert.equal(token, 'platform-agent-token');
});

test('native agent token sources fail closed when platform and inline values disagree', () => {
  assert.throws(
    () =>
      agentTokenFromEnv(
        {
          NEXOWIRE_AGENT_TOKEN: 'inline-token',
          NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME: 'agent-primary',
        },
        () => 'different-platform-token',
      ),
    /multiple secret sources with different contents/i,
  );

  assert.equal(
    agentTokenFromEnv(
      {
        NEXOWIRE_AGENT_TOKEN: 'same-token',
        NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME: 'agent-primary',
      },
      () => 'same-token',
    ),
    'same-token',
  );
});
