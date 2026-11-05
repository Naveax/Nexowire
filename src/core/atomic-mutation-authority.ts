/**
 * AI-04 source-only contract for a linearizable owner/device mutation boundary.
 *
 * A Boolean reauthorization callback is NOT a CAS or a native effect permit.
 * Production implementations must be independent, durable, authenticated and
 * shared by revocation, dispatch and the Windows native effect admission.
 * No production authority is installed by this module.
 */
import {createHash} from 'node:crypto';

export interface ServerIssuedDeviceLease {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly authorizationEpoch: number;
  readonly leaseExpiresAtMs: number;
}

export interface BoundMutationIdentity extends ServerIssuedDeviceLease {
  /** Pinned from the successful, authenticated WebSocket admission. */
  readonly authorityId: string;
}

export interface MutationIntent extends ServerIssuedDeviceLease {
  readonly requestId: string;
  readonly capability: string;
  /** SHA-256 of the exact UTF-8 WebSocket request frame. */
  readonly fingerprint: string;
}

export interface MutationReservation extends MutationIntent {
  readonly authorityId: string;
  readonly reservationId: string;
  /**
   * Only newly committed reservations may enqueue a frame.
   * A duplicate UUID, even with an identical fingerprint, is NOT a retry permit.
   */
  readonly created: boolean;
}

export interface AtomicMutationAuthority {
  /**
   * The authority MUST serialize this durable create-if-absent with owner/device
   * revoke, epoch changes and credential rotation. The deduplication key is
   * (deviceId, requestId) across reconnects AND device epoch changes.
   * Failures/unknown responses must retain a tombstone.
   */
  reserveFresh(intent: Readonly<MutationIntent>): Promise<MutationReservation | null>;

  /**
   * Atomically order revocation against the synchronous enqueue callback.
   * Return only after the callback has run once or throw. Never resubmit it.
   * A remote DB check followed by an unguarded socket.send is NOT sufficient.
   */
  dispatchIfCurrent(
    reservation: Readonly<MutationReservation>,
    enqueueFrame: () => void,
  ): Promise<void>;

  /**
   * SEPARATE, protected Windows Agent admission: revalidate authoritative
   * epoch/lease/revoke and consume the unique effect ID before invoking effect.
   * Must not trust the Hub Boolean verifier, the wire frame or client receipt.
   * Loss of the native commit ACK remains UNKNOWN and never reruns effect.
   */
  admitNativeEffectOnce(
    reservation: Readonly<MutationReservation>,
    effect: () => Promise<void>,
  ): Promise<void>;
}

export type MutationLeaseVerifier = () => Promise<ServerIssuedDeviceLease | undefined>;

export class MutationAuthorityDenied extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MutationAuthorityDenied';
  }
}

function deny(code: string): never {
  throw new MutationAuthorityDenied(code);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{1,127}$/;
const MAX_LEASE_MS = 300_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

function validLease(value: ServerIssuedDeviceLease | undefined, now: number): value is ServerIssuedDeviceLease {
  return !!value && typeof value.ownerId === 'string' && typeof value.deviceId === 'string' &&
    SAFE_ID.test(value.ownerId) && SAFE_ID.test(value.deviceId) &&
    Number.isSafeInteger(value.authorizationEpoch) && value.authorizationEpoch >= 0 &&
    Number.isSafeInteger(value.leaseExpiresAtMs) &&
    value.leaseExpiresAtMs > now &&
    value.leaseExpiresAtMs <= now + MAX_LEASE_MS;
}

function sameScope(a: ServerIssuedDeviceLease, b: ServerIssuedDeviceLease): boolean {
  return a.ownerId === b.ownerId &&
    a.deviceId === b.deviceId &&
    a.authorizationEpoch === b.authorizationEpoch;
}

export interface WireMutation {
  readonly requestId: string;
  readonly capability: string;
  /** An already serialized frame, no mutable input references or getters. */
  readonly frame: string;
}

function parseExactMutationWire(request: WireMutation): string {
  if (!UUID.test(request.requestId) ||
      typeof request.capability !== 'string' ||
      request.capability.length < 1 || request.capability.length > 128 ||
      typeof request.frame !== 'string' ||
      Buffer.byteLength(request.frame, 'utf8') > MAX_FRAME_BYTES) {
    return deny('MUTATION_WIRE_INVALID');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(request.frame);
  } catch {
    return deny('MUTATION_WIRE_INVALID');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return deny('MUTATION_WIRE_INVALID');
  }
  const value = decoded as Record<string, unknown>;
  if (value.type !== 'request' || value.requestId !== request.requestId ||
      value.capability !== request.capability ||
      !Object.hasOwn(value, 'input') ||
      Object.keys(value).length !== 5 ||
      JSON.stringify(value) !== request.frame ||
      (value.accessMode !== 'safe' && value.accessMode !== 'full')) {
    return deny('MUTATION_WIRE_SCOPE_MISMATCH');
  }
  return createHash('sha256').update(request.frame, 'utf8').digest('hex');
}

function sameReservation(
  permit: MutationReservation,
  intent: MutationIntent,
  authorityId: string,
): boolean {
  return permit.authorityId === authorityId &&
    UUID.test(permit.reservationId) &&
    DIGEST.test(permit.fingerprint) &&
    permit.ownerId === intent.ownerId &&
    permit.deviceId === intent.deviceId &&
    permit.authorizationEpoch === intent.authorizationEpoch &&
    permit.requestId === intent.requestId &&
    permit.capability === intent.capability &&
    permit.fingerprint === intent.fingerprint &&
    Number.isSafeInteger(permit.leaseExpiresAtMs) &&
    permit.leaseExpiresAtMs > 0 &&
    permit.leaseExpiresAtMs <= intent.leaseExpiresAtMs;
}

export class AtomicMutationCoordinator {
  constructor(
    private readonly binding: Readonly<BoundMutationIdentity>,
    private readonly verifier: MutationLeaseVerifier | undefined,
    private readonly authority: AtomicMutationAuthority | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * For mutations only. Call from a trusted, already authenticated remote
   * admission boundary. This is NOT automatically wired into AgentBroker.
   */
  async dispatch(
    request: WireMutation,
    enqueueFrame: (exactFrame: string) => void,
  ): Promise<MutationReservation> {
    if (!this.verifier || !this.authority) deny('AGENT_AUTH_NOT_BOUND');
    if (!this.binding.authorityId || !SAFE_ID.test(this.binding.authorityId) ||
        !validLease(this.binding, this.now())) deny('AGENT_AUTH_REVOKED');

    const fingerprint = parseExactMutationWire(request);
    let current: ServerIssuedDeviceLease | undefined;
    try { current = await this.verifier(); } catch { /* authority unavailable: deny */ }
    if (!validLease(current, this.now()) || !sameScope(current, this.binding)) {
      deny('AGENT_AUTH_REVOKED');
    }
    const intent: MutationIntent = Object.freeze({
      ownerId: current.ownerId,
      deviceId: current.deviceId,
      authorizationEpoch: current.authorizationEpoch,
      leaseExpiresAtMs: Math.min(current.leaseExpiresAtMs, this.binding.leaseExpiresAtMs),
      requestId: request.requestId,
      capability: request.capability,
      fingerprint,
    });
    if (intent.leaseExpiresAtMs <= this.now()) deny('AGENT_AUTH_REVOKED');

    let permit: MutationReservation | null = null;
    try { permit = await this.authority.reserveFresh(intent); }
    catch { deny('MUTATION_CAS_UNAVAILABLE'); }
    if (!permit) deny('MUTATION_CAS_UNAVAILABLE');
    if (!sameReservation(permit, intent, this.binding.authorityId)) {
      deny('MUTATION_CAS_INVALID_RECEIPT');
    }
    if (!permit.created) deny('MUTATION_ALREADY_RESERVED');
    if (permit.leaseExpiresAtMs <= this.now()) deny('AGENT_AUTH_REVOKED');

    // Reserve is irreversible. Any dispatch failure is UNKNOWN rather than a
    // retry opportunity, even if an exception appears to happen before send.
    try {
      await this.authority.dispatchIfCurrent(permit, () => {
        if (permit!.leaseExpiresAtMs <= this.now()) deny('AGENT_AUTH_REVOKED');
        enqueueFrame(request.frame);
      });
    } catch {
      deny('MUTATION_STATE_UNKNOWN');
    }
    return Object.freeze({...permit});
  }
}

/**
 * Invoke only in an independently protected Windows Agent/native Broker.
 * Its provider MUST recheck authority and perform one-time effect admission.
 * The Hub's successful enqueue is never sufficient to execute an OS effect.
 */
export async function executeNativeMutationOnce(
  authority: AtomicMutationAuthority | undefined,
  reservation: Readonly<MutationReservation>,
  effect: () => Promise<void>,
): Promise<void> {
  if (!authority) deny('NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
  try {
    await authority.admitNativeEffectOnce(reservation, effect);
  } catch {
    deny('NATIVE_MUTATION_EFFECT_NOT_ADMITTED');
  }
}
