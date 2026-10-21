/**
 * Conservative source-only native witness boundary.
 * No registered native reader means UNAVAILABLE, not a synthetic PASS.
 * Does not call Windows/Broker/UAC/network, and never grants a permission.
 */
import type {
  BrokerReadonlyProvider, BrokerStatusRequest, BrokerTokenEvidence,
  ExternalWitnessEvidence, OwnerCoreGrantEvidence, ParentImportEvidence,
  ProbeEnvelope, RunningBrokerImage, UntrustedSignals,
} from "./core-broker-readonly-preflight.js";

export interface NativeWitnessReaders {
  readonly readRunningImage?: () => Promise<ProbeEnvelope<RunningBrokerImage>>;
  readonly readWindowsToken?: () => Promise<ProbeEnvelope<BrokerTokenEvidence>>;
  readonly readParentImports?: () => Promise<ProbeEnvelope<ParentImportEvidence>>;
  readonly readOwnerCoreGrant?: () => Promise<ProbeEnvelope<OwnerCoreGrantEvidence>>;
  readonly readExternalWitness?: () => Promise<ProbeEnvelope<ExternalWitnessEvidence>>;
  readonly readStatusRequest?: () => Promise<ProbeEnvelope<BrokerStatusRequest>>;
  readonly readUntrustedSignals?: () => Promise<ProbeEnvelope<UntrustedSignals>>;
}

function unavailable<T>(): Promise<ProbeEnvelope<T>> {
  return Promise.resolve({ state: "unavailable" });
}
function conservative<T>(
  reader: (() => Promise<ProbeEnvelope<T>>) | undefined,
): () => Promise<ProbeEnvelope<T>> {
  if (typeof reader !== "function") return unavailable<T>;
  return async () => {
    try {
      const result: unknown = await reader();
      if (result === null || typeof result !== "object" ||
          !("state" in result) ||
          !["reported", "unavailable", "unknown", "error"].includes(
            String(result.state))) return { state: "unavailable" };
      return result as ProbeEnvelope<T>;
    } catch {
      // Raw errors could include a credential, privileged path or secret.
      return { state: "unavailable" };
    }
  };
}
export function createConservativeNativeBrokerProvider(
  readers: NativeWitnessReaders = {},
): BrokerReadonlyProvider {
  return {
    readRunningImage: conservative(readers.readRunningImage),
    readWindowsToken: conservative(readers.readWindowsToken),
    readParentImports: conservative(readers.readParentImports),
    readOwnerCoreGrant: conservative(readers.readOwnerCoreGrant),
    readExternalWitness: conservative(readers.readExternalWitness),
    readStatusRequest: conservative(readers.readStatusRequest),
    readUntrustedSignals: conservative(readers.readUntrustedSignals),
  };
}
