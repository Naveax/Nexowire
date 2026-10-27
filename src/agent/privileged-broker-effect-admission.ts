import { createHash } from 'node:crypto';

/**
 * Broker-owned adapter boundary for a separately deployed monotonic,
 * rollback-resistant CAS and independently verified Windows/owner identity.
 *
 * There is intentionally NO production adapter in this source branch.
 * A bearer token, HTTP body, environment flag, UI status, in-memory Map,
 * or a test fixture is NOT an admission provider. Until independently
 * provisioned, all execute paths are denied.
 */
export interface BrokerVerifiedEffectBinding {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly ownerEpoch: number;
  readonly deviceEpoch: number;
  readonly sessionEpoch: number;
  readonly generation: number;
  readonly highTokenProofId: string;
  readonly expiresAtMs: number;
}

export interface BrokerEffectRequest {
  readonly operationId: string;
  readonly capability: string;
  readonly inputSha256: string;
  readonly binding: BrokerVerifiedEffectBinding;
}

export interface BrokerExternalEffectAdmission {
  /** Independent Broker-side readback; must reject UNKNOWN/revoked tokens. */
  readVerifiedBinding(): Promise<BrokerVerifiedEffectBinding | null>;
  /** External atomic CAS, unique operation ID and binding, no in-memory mock in production. */
  begin(request: BrokerEffectRequest): Promise<{
    readonly state: 'RESERVED';
    readonly operationId: string;
    readonly ticket: string;
  } | null>;
  /** Irreversibly consume before any callback; lost ACK MUST NOT be replayed. */
  commit(request: BrokerEffectRequest, ticket: string): Promise<{
    readonly state: 'COMMITTED';
    readonly operationId: string;
    readonly ticket: string;
  } | null>;
  /** Synchronous, *fresh OS-token/epoch* readback immediately before invocation. */
  readVerifiedBindingNow(): BrokerVerifiedEffectBinding | null;
}

export class BrokerEffectAdmissionDenied extends Error {
  readonly code = 'BROKER_EFFECT_ADMISSION_REQUIRED';
  constructor() {
    super('BROKER_EFFECT_ADMISSION_REQUIRED');
    this.name = 'BrokerEffectAdmissionDenied';
  }
}

const OPERATION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64=/^[a-f0-9]{64}$/i;
const VALID_ID=/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,191}$/;

function validBinding(binding: BrokerVerifiedEffectBinding | null | undefined):
  binding is BrokerVerifiedEffectBinding {
  if (!binding || typeof binding !== 'object') return false;
  for(const field of ['ownerId','deviceId','sessionId','highTokenProofId'] as const) {
    if (typeof binding[field] !== 'string' || !VALID_ID.test(binding[field])) return false;
  }
  for(const field of ['ownerEpoch','deviceEpoch','sessionEpoch','generation'] as const) {
    if (!Number.isSafeInteger(binding[field]) || binding[field] < 1) return false;
  }
  return Number.isSafeInteger(binding.expiresAtMs) && binding.expiresAtMs > Date.now();
}

function equivalent(a: BrokerVerifiedEffectBinding,b: BrokerVerifiedEffectBinding): boolean {
  return a.ownerId === b.ownerId && a.deviceId === b.deviceId &&
    a.sessionId === b.sessionId && a.ownerEpoch === b.ownerEpoch &&
    a.deviceEpoch === b.deviceEpoch && a.sessionEpoch === b.sessionEpoch &&
    a.generation === b.generation &&
    a.highTokenProofId === b.highTokenProofId &&
    a.expiresAtMs === b.expiresAtMs;
}

function reject(): never { throw new BrokerEffectAdmissionDenied(); }

/**
 * No callback occurs until externally committed, then fresh independent
 * evidence is rechecked AFTER all awaits and synchronously at the call site.
 * The provider's implementation itself still requires separate security
 * review/physical acceptance. No adapter -> no effects.
 */
export async function invokeBrokerEffectOnce<T>(
  authority: BrokerExternalEffectAdmission | undefined,
  operationId: unknown,
  capability: string,
  input: unknown,
  execute: () => T | Promise<T>,
  verifyWindowsElevationNow: () => boolean,
): Promise<T> {
  if (!authority || typeof operationId !== 'string' ||
      !OPERATION_ID.test(operationId) || typeof capability !== 'string') reject();

  // Stable request bytes for external owner-intent verification. Request ID
  // and digest are binding inputs, never themselves proof of approval.
  let json: string | undefined;
  try { json = JSON.stringify({capability,input}); } catch { reject(); }
  if (!json || json.length > 4*1024*1024) reject();
  const inputSha256 = createHash('sha256').update(json).digest('hex');
  if (!HEX_64.test(inputSha256)) reject();
  let initial: BrokerVerifiedEffectBinding | null;
  try { initial = await authority.readVerifiedBinding(); } catch { reject(); }
  if (!validBinding(initial)) reject();
  const request: BrokerEffectRequest = Object.freeze({
    operationId, capability, inputSha256, binding: Object.freeze({...initial}),
  });
  let ticket: string;
  try {
    const reservation = await authority.begin(request);
    if (!reservation || reservation.state !== 'RESERVED' ||
        reservation.operationId !== operationId ||
        typeof reservation.ticket !== 'string' ||
        !/^[a-zA-Z0-9_-]{24,256}$/.test(reservation.ticket)) reject();
    ticket=reservation.ticket;
  } catch { reject(); }
  try {
    const committed = await authority.commit(request,ticket!);
    if (!committed || committed.state !== 'COMMITTED' ||
        committed.operationId !== operationId ||
        committed.ticket !== ticket) reject();
  } catch { reject(); }
  let current: BrokerVerifiedEffectBinding | null;
  try { current = await authority.readVerifiedBinding(); } catch { reject(); }
  if (!validBinding(current) || !equivalent(initial,current)) reject();

  // No further await between these checks and the *synchronous invocation*
  // of the first effect callback. Later effects inside a callback still
  // require their own executor-side fence; this is the Broker entry gate.
  let immediate: BrokerVerifiedEffectBinding | null;
  try { immediate = authority.readVerifiedBindingNow(); } catch { reject(); }
  if (!validBinding(immediate) || !equivalent(initial,immediate) ||
      !verifyWindowsElevationNow()) reject();

  return execute();
}
