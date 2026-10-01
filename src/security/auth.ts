import {
  bearerFromHeader,
  matchesAnyToken,
} from './tokens.js';
import type {
  CredentialMetadata,
  CredentialRole,
  CredentialScope,
  CredentialStore,
} from './credential-store.js';
import type {
  ExternalIdentityGrant,
  OidcVerifier,
} from './oidc.js';

export type BearerAuthorization =
  | {
      kind: 'static';
      scope: CredentialScope;
    }
  | {
      kind: 'stored';
      scope: CredentialScope;
      credential: CredentialMetadata;
    }
  | {
      kind: 'oidc';
      scope: 'mcp';
      identity: ExternalIdentityGrant;
    };

export function resolveBearerAuthorization(
  header: string | undefined,
  scope: CredentialScope,
  staticTokens: readonly string[],
  credentials?: CredentialStore,
): BearerAuthorization | undefined {
  const token = bearerFromHeader(header);
  if (!token) return undefined;

  if (matchesAnyToken(token, staticTokens)) {
    return {
      kind: 'static',
      scope,
    };
  }

  const credential = credentials?.authenticate(scope, token);
  if (!credential) return undefined;

  return {
    kind: 'stored',
    scope,
    credential,
  };
}

export function authorizeBearer(
  header: string | undefined,
  scope: CredentialScope,
  staticTokens: readonly string[],
  credentials?: CredentialStore,
): boolean {
  return (
    resolveBearerAuthorization(
      header,
      scope,
      staticTokens,
      credentials,
    ) !== undefined
  );
}

export interface AuthorizationGrant {
  role: CredentialRole;
  allowedTools?: string[];
  allowedDeviceIds?: string[];
  allowedRoutingPolicies?: string[];
}

export function authorizationGrant(
  authorization: BearerAuthorization | undefined,
): AuthorizationGrant | undefined {
  if (!authorization || authorization.kind === 'static') {
    return undefined;
  }
  if (authorization.kind === 'stored') {
    return {
      role:
        authorization.credential.role ??
        (authorization.credential.administrative === true
          ? 'admin'
          : 'user'),
      ...(authorization.credential.allowedTools
        ? {
            allowedTools: [
              ...authorization.credential.allowedTools,
            ],
          }
        : {}),
      ...(authorization.credential.allowedDeviceIds
        ? {
            allowedDeviceIds: [
              ...authorization.credential.allowedDeviceIds,
            ],
          }
        : {}),
      ...(authorization.credential.allowedRoutingPolicies
        ? {
            allowedRoutingPolicies: [
              ...authorization.credential.allowedRoutingPolicies,
            ],
          }
        : {}),
    };
  }

  return {
    role: authorization.identity.role,
    ...(authorization.identity.allowedTools
      ? { allowedTools: [...authorization.identity.allowedTools] }
      : {}),
    ...(authorization.identity.allowedDeviceIds
      ? {
          allowedDeviceIds: [
            ...authorization.identity.allowedDeviceIds,
          ],
        }
      : {}),
    ...(authorization.identity.allowedRoutingPolicies
      ? {
          allowedRoutingPolicies: [
            ...authorization.identity.allowedRoutingPolicies,
          ],
        }
      : {}),
  };
}

export async function resolveMcpAuthorization(
  header: string | undefined,
  staticTokens: readonly string[],
  credentials?: CredentialStore,
  oidc?: OidcVerifier,
): Promise<BearerAuthorization | undefined> {
  const local = resolveBearerAuthorization(
    header,
    'mcp',
    staticTokens,
    credentials,
  );
  if (local) return local;
  if (!oidc) return undefined;

  const identity = await oidc.verifyBearerHeader(header);
  if (!identity) return undefined;
  return {
    kind: 'oidc',
    scope: 'mcp',
    identity,
  };
}
