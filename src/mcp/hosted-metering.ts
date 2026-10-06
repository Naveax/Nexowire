import { createHash } from 'node:crypto';
import type {
  ControlPlaneMcpClient,
} from '../hub/control-plane-mcp-auth.js';
import type {
  BearerAuthorization,
} from '../security/auth.js';
import {
  requestedMcpToolNames,
} from '../security/tool-authorization.js';

export interface HostedMcpMeteringDecision {
  allowed: boolean;
  status?: number;
  code?: string;
  error?: string;
  remainingCredits?: number | null;
}

export function hostedMcpUsageEventId(input: {
  accountId: string;
  body: unknown;
  toolName: string;
}): string {
  const digest = createHash('sha256')
    .update(input.accountId, 'utf8')
    .update('\0')
    .update(input.toolName, 'utf8')
    .update('\0')
    .update(JSON.stringify(input.body), 'utf8')
    .digest('hex');

  return 'mcp-' + digest;
}

/** The MCP caller marks tool calls made in a special-skill workflow using
 * params._meta['nexowire/special-skill'] = true. Dedicated skill tools
 * are independently classified by their name by quoteToolUsage(). */
function hasSpecialSkillContext(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const params = (body as Record<string, unknown>).params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const meta = (params as Record<string, unknown>)._meta;
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) &&
    (meta as Record<string, unknown>)['nexowire/special-skill'] === true;
}

export async function enforceHostedMcpMetering(input: {
  authorization: BearerAuthorization | undefined;
  authorizationHeader: string | undefined;
  body: unknown;
  client: ControlPlaneMcpClient | undefined;
}): Promise<HostedMcpMeteringDecision> {
  if (input.authorization?.kind !== 'control-plane') {
    return { allowed: true };
  }

  if (!input.client) {
    return {
      allowed: false,
      status: 503,
      error: 'service_unavailable',
      code: 'MCP_METERING_UNAVAILABLE',
    };
  }

  const requestedTools =
    requestedMcpToolNames(input.body);
  if (requestedTools.length > 1) {
    return {
      allowed: false,
      status: 400,
      error: 'invalid_request',
      code: 'MCP_METERED_BATCH_UNSUPPORTED',
    };
  }

  for (const toolName of requestedTools) {
    const decision = await input.client.chargeTool({
      accountId: input.authorization.accountId,
      eventId: hostedMcpUsageEventId({
        accountId: input.authorization.accountId,
        body: input.body,
        toolName,
      }),
      toolName,
      ...(hasSpecialSkillContext(input.body) ? { specialSkill: true } : {}),
    });

    if (!decision) {
      return {
        allowed: false,
        status: 503,
        error: 'service_unavailable',
        code: 'MCP_METERING_UNAVAILABLE',
      };
    }

    // The D1 ledger deduplicates the charge, not tool execution.
    // Repeated identical calls must not execute again without a charge.
    if (decision.status === 'duplicate') {
      return {
        allowed: false,
        status: 409,
        error: 'duplicate_request',
        code: 'MCP_DUPLICATE_REQUEST',
        remainingCredits: decision.remainingCredits,
      };
    }

    if (decision.status === 'denied') {
      const featureDenied =
        decision.reason === 'feature-not-in-plan';
      return {
        allowed: false,
        status: featureDenied ? 403 : 429,
        error: featureDenied
          ? 'forbidden'
          : 'quota_exhausted',
        code: featureDenied
          ? 'MCP_FEATURE_NOT_IN_PLAN'
          : 'MCP_QUOTA_EXHAUSTED',
        remainingCredits:
          decision.remainingCredits,
      };
    }
  }

  return { allowed: true };
}
