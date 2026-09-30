import * as z from 'zod';
import type { BearerAuthorization } from './auth.js';

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

  const patterns = authorization.credential.allowedTools;
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
