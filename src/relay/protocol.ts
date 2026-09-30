import * as z from 'zod';

export const RELAY_HUB_PATH = '/relay/hub';
export const RELAY_AGENT_PATH = '/relay/agent';

const ConnectionIdSchema = z.string().uuid();

export const RelayToHubMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent.open'),
    connectionId: ConnectionIdSchema,
  }),
  z.object({
    type: z.literal('agent.message'),
    connectionId: ConnectionIdSchema,
    data: z.string().max(33_554_432),
  }),
  z.object({
    type: z.literal('agent.close'),
    connectionId: ConnectionIdSchema,
    code: z.number().int().min(1000).max(4999).optional(),
    reason: z.string().max(1024).optional(),
  }),
]);

export const HubToRelayMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent.send'),
    connectionId: ConnectionIdSchema,
    data: z.string().max(33_554_432),
  }),
  z.object({
    type: z.literal('agent.close'),
    connectionId: ConnectionIdSchema,
    code: z.number().int().min(1000).max(4999).optional(),
    reason: z.string().max(1024).optional(),
  }),
]);

export type RelayToHubMessage = z.infer<
  typeof RelayToHubMessageSchema
>;
export type HubToRelayMessage = z.infer<
  typeof HubToRelayMessageSchema
>;
