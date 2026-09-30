import {
  bearerFromHeader,
  matchesAnyToken,
} from './tokens.js';
import type {
  CredentialScope,
  CredentialStore,
} from './credential-store.js';

export function authorizeBearer(
  header: string | undefined,
  scope: CredentialScope,
  staticTokens: readonly string[],
  credentials?: CredentialStore,
): boolean {
  const token = bearerFromHeader(header);
  if (!token) return false;
  return (
    matchesAnyToken(token, staticTokens) ||
    credentials?.verify(scope, token) === true
  );
}
