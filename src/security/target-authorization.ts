import {
  authorizationGrant,
  type BearerAuthorization,
} from './auth.js';

export function hasMcpTargetRestrictions(
  authorization: BearerAuthorization | undefined,
): boolean {
  const grant = authorizationGrant(authorization);
  return (
    authorization?.scope === 'mcp' &&
    ((grant?.allowedDeviceIds?.length ?? 0) > 0 ||
      (grant?.allowedRoutingPolicies?.length ?? 0) > 0)
  );
}

export function directlyAuthorizedDeviceIds(
  authorization: BearerAuthorization | undefined,
): readonly string[] {
  if (authorization?.scope !== 'mcp') return [];
  return authorizationGrant(authorization)?.allowedDeviceIds ?? [];
}

export function authorizedRoutingPolicyNames(
  authorization: BearerAuthorization | undefined,
): readonly string[] {
  if (authorization?.scope !== 'mcp') return [];
  return authorizationGrant(authorization)?.allowedRoutingPolicies ?? [];
}

export function isRoutingPolicyAuthorized(
  authorization: BearerAuthorization | undefined,
  name: string,
): boolean {
  if (!hasMcpTargetRestrictions(authorization)) return true;
  const normalized = name.trim().toLowerCase();
  return authorizedRoutingPolicyNames(authorization).includes(normalized);
}
