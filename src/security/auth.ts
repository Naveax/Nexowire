import {
  bearerFromHeader,
  matchesAnyToken,
} from './tokens.js';
import type {
  CredentialMetadata,
  CredentialScope,
  CredentialStore,
} from './credential-store.js';

export type BearerAuthorization =
  | {
      kind: 'static';
      scope: CredentialScope;
    }
  | {
      kind: 'stored';
      scope: CredentialScope;
      credential: CredentialMetadata;
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
