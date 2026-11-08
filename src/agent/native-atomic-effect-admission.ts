/** Native-side effect admission, never supplied by Hub or WebSocket JSON.
 * The injected provider must be a protected, independent OS/authority client;
 * this module does not implement or claim such a provider.
 */
import {createHash} from 'node:crypto';
import {executeNativeMutationOnce, MutationAuthorityDenied,
  type AtomicMutationAuthority, type MutationReservation} from '../core/atomic-mutation-authority.js';

export interface TrustedNativeMutationProvider {
  authority: AtomicMutationAuthority;
  /** Must authenticate the exact request against an independent durable CAS. */
  resolveTrustedReservation(input: Readonly<{
    deviceId: string; requestId: string; capability: string; wireSha256: string;
  }>, signal: AbortSignal): Promise<MutationReservation | undefined>;
}

export async function executeTrustedNativeMutation<T>(
  input: Readonly<{
    provider?: TrustedNativeMutationProvider;
    deviceId: string; requestId: string; capability: string;
    exactFrame: string; signal?: AbortSignal;
    timeoutMs?: number;
  }>,
  effect: () => Promise<T>,
): Promise<T> {
  if (!input.provider || !input.provider.authority ||
      typeof input.provider.resolveTrustedReservation !== 'function') {
    throw new MutationAuthorityDenied('NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
  }
  if (input.signal?.aborted) {
    throw new MutationAuthorityDenied('NATIVE_MUTATION_REQUEST_ABORTED');
  }
  const timeout = input.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeout) || timeout < 250 || timeout > 10_000) {
    throw new MutationAuthorityDenied('NATIVE_MUTATION_TIMEOUT_INVALID');
  }
  const wireSha256 = createHash('sha256').update(input.exactFrame,'utf8').digest('hex');
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const abort = () => ctrl.abort();
  input.signal?.addEventListener('abort', abort, {once:true});
  try {
    const permit = await Promise.race([
      input.provider.resolveTrustedReservation(Object.freeze({
        deviceId:input.deviceId, requestId:input.requestId,
        capability:input.capability, wireSha256,
      }),ctrl.signal),
      new Promise<undefined>(resolve => {
        // Referenced timer: no early Node 22 event-loop completion on stalled authority.
        timer = setTimeout(() => {ctrl.abort();resolve(undefined);},timeout);
      }),
    ]);
    if (ctrl.signal.aborted || input.signal?.aborted) {
      throw new MutationAuthorityDenied('NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
    }
    if (!permit || !permit.created ||
        permit.deviceId !== input.deviceId ||
        permit.requestId !== input.requestId ||
        permit.capability !== input.capability ||
        permit.fingerprint !== wireSha256 ||
        !Number.isSafeInteger(permit.authorizationEpoch) ||
        permit.authorizationEpoch < 1 ||
        !Number.isSafeInteger(permit.leaseExpiresAtMs) ||
        permit.leaseExpiresAtMs <= Date.now() ||
        typeof permit.ownerId !== 'string' || permit.ownerId.length === 0 ||
        typeof permit.authorityId !== 'string' || permit.authorityId.length === 0) {
      throw new MutationAuthorityDenied('NATIVE_MUTATION_RESERVATION_INVALID');
    }
    let result!: T;
    // ONLY the independently protected authority may atomically admit the OS
    // effect once; a received Hub frame is not authorization.
    await executeNativeMutationOnce(input.provider.authority,permit,async () => {
      if (input.signal?.aborted) {
        throw new MutationAuthorityDenied('NATIVE_MUTATION_REQUEST_ABORTED');
      }
      result = await effect();
    });
    return result;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort',abort);
    ctrl.abort();
  }
}
