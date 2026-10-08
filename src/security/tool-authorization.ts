import * as z from 'zod';
import {
  authorizationGrant,
  type BearerAuthorization,
} from './auth.js';

export const OPERATOR_MCP_TOOLS = new Set<string>([
  'policy_profile_list',
  'policy_device_check',
  'operations_idempotency_list',
  'events_read',
  'audit_recent',
  'audit_query',
]);

export const ADMIN_MCP_TOOLS = new Set<string>([
  'policy_profile_set',
  'policy_profile_delete',
  'policy_device_bind',
  'policy_device_unbind',
  'device_route_policy_set',
  'device_route_policy_delete',
  'device_group_set',
  'device_group_delete',
  'device_alias_set',
  'device_alias_delete',
  'windows_installer_preflight',
  'windows_installer_apply',
]);

export const ToolPatternSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:\*|[A-Za-z0-9_.:-]+\*?)$/);

export function normalizeToolPatterns(
  patterns: readonly string[],
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of patterns) {
    const pattern = ToolPatternSchema.parse(value.trim());
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    normalized.push(pattern);
  }
  return normalized;
}

export function toolPatternMatches(
  pattern: string,
  toolName: string,
): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}

export function isMcpToolAuthorized(
  authorization: BearerAuthorization | undefined,
  toolName: string,
): boolean {
  if (!authorization || authorization.kind === 'static') {
    return true;
  }

  const grant = authorizationGrant(authorization);
  if (!grant) return true;
  const role = grant.role;
  if (ADMIN_MCP_TOOLS.has(toolName) && role !== 'admin') {
    return false;
  }
  if (
    OPERATOR_MCP_TOOLS.has(toolName) &&
    role !== 'operator' &&
    role !== 'admin'
  ) {
    return false;
  }

  const patterns = grant.allowedTools;
  if (!patterns) return true;
  return patterns.some((pattern) =>
    toolPatternMatches(pattern, toolName),
  );
}

export function requestedMcpToolNames(body: unknown): string[] {
  const requests = Array.isArray(body) ? body : [body];
  const names: string[] = [];

  for (const request of requests) {
    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request)
    ) {
      continue;
    }
    const record = request as Record<string, unknown>;
    if (record.method !== 'tools/call') continue;

    const params = record.params;
    if (
      typeof params !== 'object' ||
      params === null ||
      Array.isArray(params)
    ) {
      continue;
    }
    const name = (params as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) {
      names.push(name);
    }
  }

  return names;
}

export function deniedMcpToolNames(
  body: unknown,
  authorization: BearerAuthorization | undefined,
): string[] {
  return requestedMcpToolNames(body).filter(
    (name) => !isMcpToolAuthorized(authorization, name),
  );
}
