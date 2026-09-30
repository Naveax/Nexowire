import type { BearerAuthorization } from './auth.js';

export function hasMcpTargetRestrictions(
  authorization: BearerAuthorization | undefined,
): boolean {
  return (
    authorization?.kind === 'stored' &&
    authorization.scope === 'mcp' &&
    ((authorization.credential.allowedDeviceIds?.length ?? 0) > 0 ||
      (authorization.credential.allowedRoutingPolicies?.length ?? 0) > 0)
  );
}

export function directlyAuthorizedDeviceIds(
  authorization: BearerAuthorization | undefined,
): readonly string[] {
  if (
    authorization?.kind !== 'stored' ||
    authorization.scope !== 'mcp'
  ) {
    return [];
  }
  return authorization.credential.allowedDeviceIds ?? [];
}

export function authorizedRoutingPolicyNames(
  authorization: BearerAuthorization | undefined,
): readonly string[] {
  if (
    authorization?.kind !== 'stored' ||
    authorization.scope !== 'mcp'
  ) {
    return [];
  }
  return authorization.credential.allowedRoutingPolicies ?? [];
}

export function isRoutingPolicyAuthorized(
  authorization: BearerAuthorization | undefined,
  name: string,
): boolean {
  if (!hasMcpTargetRestrictions(authorization)) return true;
  const normalized = name.trim().toLowerCase();
  return authorizedRoutingPolicyNames(authorization).includes(normalized);
}
