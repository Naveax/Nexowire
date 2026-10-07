import * as z from 'zod';

export const AGENT_PROTOCOL_VERSION = 2;

export const AgentDeviceSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(64),
  capabilities: z.array(z.string().min(1).max(128)).max(256),
});

export const AgentHelloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  instanceId: z.string().uuid(),
  device: AgentDeviceSchema,
});

export const HubRequestSchema = z.object({
  type: z.literal('request'),
  requestId: z.string().uuid(),
  capability: z.string().min(1).max(128),
  input: z.unknown(),
  accessMode: z.enum(['safe', 'full']).default('safe'),
});

export const AgentResponseSchema = z.object({
  type: z.literal('response'),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(4096),
      details: z.unknown().optional(),
    })
    .optional(),
});

export const AgentEventSchema = z.object({
  type: z.literal('event'),
  eventId: z.string().uuid(),
  at: z.string().datetime(),
  topic: z.string().min(1).max(128),
  data: z.unknown(),
});

export type AgentDevice = z.infer<typeof AgentDeviceSchema>;
export type AgentHello = z.infer<typeof AgentHelloSchema>;
export type HubRequest = z.infer<typeof HubRequestSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
