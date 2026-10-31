import {createHash} from 'node:crypto';
import {requiresPhysicalConsoleGrant} from './windows-console-grant.js';
import {
  evaluateCoreConsoleEnrollment,
  type CoreConsoleCurrentReadback,
  type SignedCoreConsoleEnrollmentV1,
} from './core-console-enrollment-policy.js';

export interface CoreConsoleBinding {
  readonly ownerAccountId: string;
  readonly deviceId: string;
  readonly installationId: string;
}

export interface CoreConsoleEvidence {
  readonly certificate: SignedCoreConsoleEnrollmentV1 | null;
  readonly pinnedLocalSpkiDer: Uint8Array | null;
  // Kept OUTSIDE the strict ten-field CoreConsoleCurrentReadback contract.
  // The real Windows provider must source these from a fresh D1 read; missing
  // values fail closed at its own native admission boundary.
  readonly current: CoreConsoleCurrentReadback | null;
  readonly devicePlatform?: string;
  readonly deviceReady?: boolean;
  readonly observedAtMs: number;
  readonly desktop: 'default' | 'private' | 'secure' | 'locked' | 'unknown';
  readonly nativeAdmission: 'verified' | 'unavailable';
  /** Verified from the on-device, authenticated elevated Broker health probe. */
  readonly brokerVersionVerified?: boolean;
  /** Only the locally composed native consent verifier can set true. */
  readonly nativeConsentProviderPresent?: boolean;
}

export interface CoreConsoleDispatch {
  readonly requestId: string;
  readonly capability: string;
  readonly input: unknown;
  readonly fingerprint: string;
  readonly binding: CoreConsoleBinding;
  readonly enrollmentId: string;
  readonly ownerEpoch: number;
  readonly grantGeneration: number;
  readonly revokeEpoch: number;
}

export interface CoreConsoleReceipt {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly outcome: 'succeeded' | 'denied' | 'unknown';
  readonly data?: unknown;
}

/**
 * Local composition-root dependency, NEVER deserialized from Hub input/env.
 * A production implementation must live behind the protected native boundary:
 * OS-protected enrollment/key pin; authenticated rollback-independent current
 * authority; atomic dispatch/revoke fencing; durable single-use request ledger;
 * HWND/PID+creation/session/input-desktop checks at the actual effect boundary.
 * execute() revalidates the exact epochs and fingerprint before injecting input.
 * revoke() ACKs only after a durable tombstone and cancellation/drain of work.
 * No production provider is installed by this module.
 */
export interface CoreConsoleNativeProvider {
  readonly durableReplayProtected?: true;
  readonly binding?: CoreConsoleBinding;
  enroll?(signal:AbortSignal):Promise<boolean>;
  close?():void;
  inspect(signal: AbortSignal): Promise<CoreConsoleEvidence>;
  execute(request: CoreConsoleDispatch, signal: AbortSignal): Promise<CoreConsoleReceipt>;
  revoke(): Promise<void>;
}

export interface CoreConsoleStatus {
  readonly preferenceEnabled: boolean | null;
  readonly localEnrolled: boolean;
  readonly active: boolean;
  readonly duration: 'indefinite-revocable';
  readonly expiresAt: null;
  readonly state: string;
}

function failure(code: string): Error & {code: string} {
  return Object.assign(new Error(code),{code});
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_READBACK_AGE_MS = 2_000;

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw failure('CORE_CONSOLE_REQUEST_CANCELLED');
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve,reject) => {
    cancel = () => reject(failure('CORE_CONSOLE_REQUEST_CANCELLED'));
    signal.addEventListener('abort',cancel,{once:true});
  });
  try { return await Promise.race([work,cancelled]); }
  finally { signal.removeEventListener('abort',cancel); }
}

/** Per-Agent controller. No positive cache, no ROOT expiry, no timed-grant fallback. */
export class CoreConsoleAdmission {
  private stopped = false;
  private abort = new AbortController();
  // A late affirmative native approval must never reopen a STOP issued
  // while the enrollment prompt or protected service readback was pending.
  private revokeSequence = 0;
  // Closing an Agent controller is terminal for that instance. A delayed
  // native consent callback must never resurrect a closed controller.
  private closed = false;
  private enrollmentPending = false;
  // A pending remote revoke and any lost/failed revoke ACK are authorization
  // uncertainty, never a reason to admit a fresh approval.
  private revocationsPending = 0;
  private revocationUncertain = false;
  private readonly requests = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(
    private binding?: CoreConsoleBinding,
    private readonly provider?: CoreConsoleNativeProvider,
    private readonly now: () => number = Date.now,
  ) {
    if (binding) this.binding = Object.freeze({...binding});
  }

  private inactive(state: string): CoreConsoleStatus {
    return {preferenceEnabled:null,localEnrolled:false,active:false,
      duration:'indefinite-revocable',expiresAt:null,state};
  }

  private async inspect(accessMode: 'safe' | 'full', requestSignal?: AbortSignal): Promise<{
    status: CoreConsoleStatus; evidence?: CoreConsoleEvidence;
  }> {
    if (this.stopped) return {status:this.inactive('REVOKED_LOCALLY')};
    if (!this.provider)
      return {status:this.inactive('CORE_CONSOLE_PROVIDER_UNAVAILABLE')};
    if (accessMode !== 'full') return {status:this.inactive('SAFE_MODE')};
    try {
      const signal = AbortSignal.any([this.abort.signal,
        AbortSignal.timeout(10000),...(requestSignal?[requestSignal]:[])]);
      if (signal.aborted) return {status:this.inactive('CORE_CONSOLE_REQUEST_CANCELLED')};
      const evidence = structuredClone(await untilAborted(this.provider.inspect(signal),signal));
      if (this.stopped) return {status:this.inactive('REVOKED_LOCALLY')};
      const binding=this.binding??this.provider.binding;
      if(!binding)return {status:this.inactive('LOCAL_ENROLLMENT_REQUIRED')};
      this.binding=Object.freeze({...binding});
      const nowMs = this.now();
      if (!Number.isSafeInteger(evidence.observedAtMs) ||
          !Number.isSafeInteger(nowMs) || evidence.observedAtMs > nowMs ||
          nowMs - evidence.observedAtMs > MAX_READBACK_AGE_MS)
        return {status:this.inactive('CURRENT_AUTHORITY_UNAVAILABLE')};
      const evaluationInput = {
        certificate:evidence.certificate,
        pinnedLocalSpkiDer:evidence.pinnedLocalSpkiDer,
        trustedCurrentReadback:evidence.current,
        requestedOwnerAccountId:this.binding.ownerAccountId,
        requestedDeviceId:this.binding.deviceId,
        requestedInstallationId:this.binding.installationId,
        nowMs,
      };
      const evaluation=evaluateCoreConsoleEnrollment({...evaluationInput,desktop:evidence.desktop});
      const enrollment=evidence.desktop==='default'?evaluation:
        evaluateCoreConsoleEnrollment({...evaluationInput,desktop:'default'});
      const nativeProviderPresent=evidence.nativeConsentProviderPresent===true;
      const localEnrolled=nativeProviderPresent&&enrollment.policyEligible;
      const active = nativeProviderPresent&&evaluation.policyEligible&&evidence.nativeAdmission === 'verified';
      return {evidence,status:{
        preferenceEnabled: typeof evidence.current?.coreEnabled === 'boolean'
          ? evidence.current.coreEnabled : null,
        localEnrolled,
        active,duration:'indefinite-revocable',expiresAt:null,
        state:active ? 'ACTIVE'
          : evidence.nativeConsentProviderPresent !== true ? 'LOCAL_ENROLLMENT_REQUIRED'
          : evidence.current?.coreEnabled === false ? 'CORE_NOT_EFFECTIVE'
          : evidence.brokerVersionVerified === false &&
            evidence.current?.coreEnabled === true &&
            evidence.current.accessMode === 'full' &&
            !evidence.certificate
            ? 'CORE_BROKER_VERIFICATION_REQUIRED'
          : evaluation.policyEligible
            ? 'NATIVE_ADMISSION_UNAVAILABLE' : evaluation.reason,
      }};
    } catch {
      return {status:this.inactive(this.stopped?'REVOKED_LOCALLY':
        requestSignal?.aborted?'CORE_CONSOLE_REQUEST_CANCELLED':'CURRENT_AUTHORITY_UNAVAILABLE')};
    }
  }

  async status(accessMode: 'safe' | 'full'): Promise<CoreConsoleStatus> {
    return (await this.inspect(accessMode)).status;
  }

  /** No remote reenrollment/reset method: STOP cannot be undone by a tool call. */
  async revoke(): Promise<void> {
    const sequence=++this.revokeSequence;
    this.stopped = true;
    this.abort.abort();
    ++this.revocationsPending;
    try {
      if(this.provider)await this.provider.revoke();
      // Only the most recent successful revoke ACK can clear a previous
      // unknown. A late old ACK must never certify a newer in-flight revoke.
      if(sequence===this.revokeSequence)this.revocationUncertain=false;
    } catch(error) {
      this.revocationUncertain=true;
      throw error;
    } finally {
      --this.revocationsPending;
    }
  }

  /** Only the provider's real local decision UI can reopen a stopped profile. */
  async enroll(signal:AbortSignal):Promise<boolean>{
    if(this.closed)throw failure('CORE_CONSOLE_CONTROLLER_CLOSED');
    if(!this.provider?.enroll)throw failure('CORE_CONSOLE_PROVIDER_UNAVAILABLE');
    if(signal.aborted)return false;
    if(this.revocationsPending>0)throw failure('CORE_ENROLLMENT_REVOKE_IN_PROGRESS');
    if(this.revocationUncertain)throw failure('CORE_ENROLLMENT_REVOKE_UNCERTAIN');
    // The protected provider also serializes approval, but the controller
    // must not allow another implementation to prompt/register in parallel.
    if(this.enrollmentPending)throw failure('CORE_ENROLLMENT_PROMPT_ACTIVE');
    this.enrollmentPending=true;
    const observedRevokeSequence=this.revokeSequence;
    try{
      const approved=await this.provider.enroll(signal);
      // close() and revoke() both fence delayed native approval, even if the
      // downstream provider returns true or a remote revoke ACK is lost.
      if(this.closed)throw failure('CORE_CONSOLE_CONTROLLER_CLOSED');
      if(this.revokeSequence!==observedRevokeSequence)
        throw failure('CORE_ENROLLMENT_REVOKED_DURING_APPROVAL');
      if(this.revocationsPending>0||this.revocationUncertain)
        throw failure('CORE_ENROLLMENT_REVOKE_UNCERTAIN');
      if(approved===true&&!signal.aborted){
        if(!this.provider.binding)throw failure('CORE_ENROLLMENT_BINDING_REQUIRED');
        this.binding=Object.freeze({...this.provider.binding});
        this.abort=new AbortController();this.stopped=false;
        return true;
      }
      return false;
    }finally{this.enrollmentPending=false;}
  }
  close():void {
    if(this.closed)return;
    // Fence synchronously before any provider cleanup. close() is not a
    // substitute for durable remote revoke, but cannot grant local authority.
    this.closed=true;
    this.revokeSequence++;
    this.stopped=true;
    this.abort.abort();
    this.provider?.close?.();
  }
  get installed():boolean {return this.provider!==undefined;}

  async execute(
    capability: string, input: unknown, requestId: string | undefined,
    accessMode: 'safe' | 'full',
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    if (!requiresPhysicalConsoleGrant(capability))
      throw failure('CORE_CONSOLE_SCOPE_DENIED');
    if (!requestId || !REQUEST_ID.test(requestId))
      throw failure('CORE_CONSOLE_REQUEST_ID_REQUIRED');
    // Reserve before any await. The bounded hot cache is not the durable
    // authority; a production provider retains all IDs externally, including
    // UNKNOWN. Pending local requests are never evicted.
    if (this.requests.has(requestId)) throw failure('CORE_CONSOLE_REPLAY_DENIED');
    if(this.inFlight.size>=64)throw failure('CORE_CONSOLE_CONCURRENCY_CAPACITY');
    if (this.requests.size >= 4096){
      if(this.provider?.durableReplayProtected!==true)throw failure('CORE_CONSOLE_REQUEST_CAPACITY');
      for(const id of this.requests){if(!this.inFlight.has(id)){this.requests.delete(id);break;}}
      if(this.requests.size>=4096)throw failure('CORE_CONSOLE_REQUEST_CAPACITY');
    }
    this.requests.add(requestId);
    this.inFlight.add(requestId);
    try{
    const snapshot = JSON.parse(JSON.stringify(input ?? null)) as unknown;
    const {status,evidence} = await this.inspect(accessMode,requestSignal);
    if (!status.active || !evidence?.certificate || !this.binding || !this.provider)
      throw failure(status.state);
    if (this.stopped) throw failure('REVOKED_LOCALLY');
    if (requestSignal?.aborted) throw failure('CORE_CONSOLE_REQUEST_CANCELLED');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([requestId,capability,snapshot,this.binding])).digest('hex');
    const enrollment = evidence.certificate.enrollment;
    let receipt: CoreConsoleReceipt;
    try {
      // Native provider owns the atomic final epoch/desktop/target check and
      // the actual effect. Do not fall through to the unguarded JS GUI switch.
      const signal = AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000),
        ...(requestSignal?[requestSignal]:[])]);
      receipt = await untilAborted(this.provider.execute({requestId,capability,
        input:snapshot,fingerprint,binding:this.binding,
        enrollmentId:enrollment.enrollmentId,ownerEpoch:enrollment.ownerEpoch,
        grantGeneration:enrollment.grantGeneration,revokeEpoch:enrollment.revokeEpoch,
      },signal),signal);
    } catch {
      throw failure('CORE_CONSOLE_MUTATION_STATE_UNKNOWN');
    }
    if (this.stopped || requestSignal?.aborted || !receipt || receipt.requestId !== requestId ||
        receipt.fingerprint !== fingerprint || receipt.outcome === 'unknown')
      throw failure('CORE_CONSOLE_MUTATION_STATE_UNKNOWN');
    if (receipt.outcome !== 'succeeded') throw failure('CORE_CONSOLE_NATIVE_DENIED');
    return receipt.data;
    }finally{this.inFlight.delete(requestId);}
  }
}
