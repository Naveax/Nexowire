import type { AgentOperationRecord } from '../agent/operation-journal.js';
import { fingerprintAgentRequest } from '../agent/request-cache.js';
import type { IdempotencyRecord } from './idempotency-store.js';
import { operationFingerprint } from './idempotency-store.js';
import {
  reconcileAgentOperation,
  type AgentOperationAssessment,
} from './agent-operation-reconciliation.js';

/**
 * Strict connection -> Hub -> Agent journal acceptance adapter.
 *
 * The caller MUST obtain authenticatedDeviceId from the trusted exact-device
 * Agent route, NOT from the response body or an untrusted client argument.
 * The Agent SQLite record intentionally contains no device identity.
 *
 * The Hub and Agent use DIFFERENT fingerprint contracts. Never compare
 * the Hub hash directly with the Agent's local fingerprint.
 *
 * This helper does not query a live Agent, retry mutations or prove external
 * filesystem/process/service effects. Until a caller wires trusted routed
 * retrieval into an authorized endpoint, it is staging evidence only.
 */
export function reconcileConnectionBoundAgentOperation(input: {
  operationId: string;
  expectedDeviceId: string;
  authenticatedDeviceId?: string;
  capability: string;
  payload: unknown;
  accessMode?: 'safe' | 'full';
  providerId?: string;
  hubRecord?: IdempotencyRecord;
  agentRecord?: AgentOperationRecord;
  agentOnline: boolean;
  agentAvailable?: boolean;
}): AgentOperationAssessment {
  const {
    operationId,
    expectedDeviceId,
    authenticatedDeviceId,
    capability,
    payload,
    hubRecord,
    agentRecord,
  } = input;

  const expectedHubFingerprint = operationFingerprint({
    targetId: expectedDeviceId,
    capability,
    payload,
    ...(input.providerId ? { providerId: input.providerId } : {}),
  });
  const expectedAgentFingerprint = fingerprintAgentRequest(
    capability,
    payload,
    input.accessMode ?? 'safe',
  );

  const hubMatches = Boolean(
    hubRecord &&
      hubRecord.operationId === operationId &&
      hubRecord.targetId === expectedDeviceId &&
      hubRecord.capability === capability &&
      hubRecord.fingerprint === expectedHubFingerprint,
  );
  const routeMatches = Boolean(
    expectedDeviceId &&
      authenticatedDeviceId &&
      authenticatedDeviceId === expectedDeviceId,
  );

  // The original adapter has no notion of target identity. Do not feed it a
  // terminal Agent record without BOTH authenticated route and Hub provenance.
  if (!hubMatches || !routeMatches) {
    return {
      operationId,
      hubStatus: hubMatches && hubRecord ? hubRecord.status : 'not_recorded',
      state: 'unknown',
      reason: 'journal_mismatch',
      evidenceVerified: false,
      externalSideEffectProven: false,
      automaticallyRetryable: false,
    };
  }

  return reconcileAgentOperation({
    operationId,
    capability,
    fingerprint: expectedAgentFingerprint,
    hubRecord,
    agentOnline: input.agentOnline,
    ...(input.agentAvailable !== undefined
      ? { agentAvailable: input.agentAvailable }
      : {}),
    ...(agentRecord ? { agentRecord } : {}),
  });
}
