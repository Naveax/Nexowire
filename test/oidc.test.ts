import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import {
  OidcVerificationError,
  OidcVerifier,
} from '../src/security/oidc.js';
import type { BearerAuthorization } from '../src/security/auth.js';
import {
  isMcpToolAuthorized,
} from '../src/security/tool-authorization.js';
import {
  directlyAuthorizedDeviceIds,
  isRoutingPolicyAuthorized,
} from '../src/security/target-authorization.js';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString(
    'base64url',
  );
}

function jwt(
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  kid = 'key-1',
): string {
  const header = b64({
    alg: 'RS256',
    kid,
    typ: 'JWT',
  });
  const body = b64(payload);
  const input = Buffer.from(header + '.' + body, 'ascii');
  const signature = sign('RSA-SHA256', input, privateKey);
  return header + '.' + body + '.' + signature.toString('base64url');
}

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  jwk.kid = 'key-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  const issuer = 'https://identity.example.test';
  const audience = 'nexowire-chatgpt';
  const jwksUri = issuer + '/keys';
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (
      url ===
      issuer + '/.well-known/openid-configuration'
    ) {
      return new Response(
        JSON.stringify({
          issuer,
          jwks_uri: jwksUri,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    if (url === jwksUri) {
      return new Response(
        JSON.stringify({ keys: [jwk] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response('not found', { status: 404 });
  };

  return {
    issuer,
    audience,
    privateKey,
    fetchFn,
  };
}

test('OIDC verifier validates signature, issuer, audience, time and scoped Nexowire claims', async () => {
  const now = Date.parse('2026-10-01T09:00:00.000Z');
  const fx = fixture();
  const verifier = new OidcVerifier({
    issuer: fx.issuer,
    audience: fx.audience,
    fetchFn: fx.fetchFn,
    now: () => now,
    clockSkewSeconds: 30,
  });

  const token = jwt(fx.privateKey, {
    iss: fx.issuer,
    sub: 'user-123',
    aud: [fx.audience, 'secondary'],
    iat: now / 1000 - 5,
    nbf: now / 1000 - 5,
    exp: now / 1000 + 300,
    nexowire_role: 'operator',
    nexowire_tools: ['machine_*', 'audit_recent'],
    nexowire_device_ids: ['desktop-a', 'desktop-b'],
    nexowire_routing_policies: ['Main.Route'],
  });

  const identity = await verifier.verify(token);
  assert.deepEqual(identity, {
    issuer: fx.issuer,
    subject: 'user-123',
    role: 'operator',
    allowedTools: ['machine_*', 'audit_recent'],
    allowedDeviceIds: ['desktop-a', 'desktop-b'],
    allowedRoutingPolicies: ['main.route'],
  });

  const authorization: BearerAuthorization = {
    kind: 'oidc',
    scope: 'mcp',
    identity,
  };
  assert.equal(
    isMcpToolAuthorized(authorization, 'machine_snapshot'),
    true,
  );
  assert.equal(
    isMcpToolAuthorized(authorization, 'audit_recent'),
    true,
  );
  assert.equal(
    isMcpToolAuthorized(authorization, 'device_alias_set'),
    false,
  );
  assert.deepEqual(
    directlyAuthorizedDeviceIds(authorization),
    ['desktop-a', 'desktop-b'],
  );
  assert.equal(
    isRoutingPolicyAuthorized(authorization, 'MAIN.ROUTE'),
    true,
  );
  assert.equal(
    isRoutingPolicyAuthorized(authorization, 'other-route'),
    false,
  );
});

test('OIDC verifier rejects invalid signature, issuer, audience, expiry and future activation', async () => {
  const now = Date.parse('2026-10-01T09:00:00.000Z');
  const fx = fixture();
  const verifier = new OidcVerifier({
    issuer: fx.issuer,
    audience: fx.audience,
    fetchFn: fx.fetchFn,
    now: () => now,
    clockSkewSeconds: 0,
  });

  const base = {
    iss: fx.issuer,
    sub: 'user-123',
    aud: fx.audience,
    exp: now / 1000 + 300,
  };

  const badAudience = jwt(fx.privateKey, {
    ...base,
    aud: 'wrong',
  });
  await assert.rejects(
    () => verifier.verify(badAudience),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_AUDIENCE_MISMATCH',
  );

  const badIssuer = jwt(fx.privateKey, {
    ...base,
    iss: 'https://other.example.test',
  });
  await assert.rejects(
    () => verifier.verify(badIssuer),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_ISSUER_MISMATCH',
  );

  const expired = jwt(fx.privateKey, {
    ...base,
    exp: now / 1000 - 1,
  });
  await assert.rejects(
    () => verifier.verify(expired),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_TOKEN_EXPIRED',
  );

  const future = jwt(fx.privateKey, {
    ...base,
    nbf: now / 1000 + 60,
  });
  await assert.rejects(
    () => verifier.verify(future),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_TOKEN_NOT_ACTIVE',
  );

  const parts = jwt(fx.privateKey, base).split('.');
  const payload = JSON.parse(
    Buffer.from(parts[1]!, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  payload.sub = 'tampered-user';
  const tampered =
    parts[0] + '.' + b64(payload) + '.' + parts[2];
  await assert.rejects(
    () => verifier.verify(tampered),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_SIGNATURE_INVALID',
  );
});

test('OIDC verifier fail-closes unsupported algorithms and malformed authorization claims', async () => {
  const now = Date.parse('2026-10-01T09:00:00.000Z');
  const fx = fixture();
  const verifier = new OidcVerifier({
    issuer: fx.issuer,
    audience: fx.audience,
    fetchFn: fx.fetchFn,
    now: () => now,
  });

  const unsigned =
    b64({ alg: 'none', kid: 'key-1' }) +
    '.' +
    b64({
      iss: fx.issuer,
      sub: 'user',
      aud: fx.audience,
      exp: now / 1000 + 300,
    }) +
    '.AA';

  await assert.rejects(
    () => verifier.verify(unsigned),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_ALG_UNSUPPORTED',
  );

  const badRole = jwt(fx.privateKey, {
    iss: fx.issuer,
    sub: 'user',
    aud: fx.audience,
    exp: now / 1000 + 300,
    nexowire_role: 'superadmin',
  });
  await assert.rejects(
    () => verifier.verify(badRole),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_ROLE_INVALID',
  );

  const badTools = jwt(fx.privateKey, {
    iss: fx.issuer,
    sub: 'user',
    aud: fx.audience,
    exp: now / 1000 + 300,
    nexowire_tools: '*',
  });
  await assert.rejects(
    () => verifier.verify(badTools),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_CLAIM_TYPE_INVALID',
  );
});

test('OIDC verifier permits insecure HTTP only for loopback by default', () => {
  assert.doesNotThrow(
    () =>
      new OidcVerifier({
        issuer: 'http://127.0.0.1:5555',
        audience: 'test',
      }),
  );

  assert.throws(
    () =>
      new OidcVerifier({
        issuer: 'http://identity.example.test',
        audience: 'test',
      }),
    (error: unknown) =>
      error instanceof OidcVerificationError &&
      error.code === 'OIDC_INSECURE_URL',
  );
});
