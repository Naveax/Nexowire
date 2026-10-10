import { validateAdminBridgeModeIntent, type AdminBridgeModeIntent } from '../protocol/admin-bridge-intent.js';

/**
 * Source of these facts MUST be independent privileged local verification,
 * never a browser body, model output, untrusted Agent command or JSON receipt.
 * A boolean in this interface is not an attestation by itself.
 */
export interface BridgeGuardianTrustedFacts {
  readonly deviceId: string;
  readonly ownerAccountId: string;
  readonly credentialBinding: string;
  readonly platform: 'win32' | 'other';
  readonly accessMode: 'full' | 'safe';
  readonly currentPreference: {
    readonly desiredMode: 'auto' | 'on' | 'off';
    /** Opaque most recent owner-preference audit event ID. */
    readonly revision: string;
  };
  readonly ownerApproval: {
    /** Exact request UUID owner approved in a durable, authenticated session. */
    readonly requestId: string;
    readonly preferenceRevision: string;
  } | null;
  readonly localGuardian: {
    readonly installed: boolean;
    readonly online: boolean;
    readonly independentlyReachableWithBrokerOff: boolean;
    readonly protectedSourceVerified: boolean;
    readonly taskIdentityVerified: boolean;
    readonly elevatedLocalTokenVerified: boolean;
    readonly hubTransportAuthenticated: boolean;
    /** Independently authenticated paired Agent, not just a credential digest. */
    readonly currentDeviceSessionVerified: boolean;
  };
  readonly broker: {
    readonly canonicalTaskIdentityVerified: boolean;
    readonly launcherAclVerified: boolean;
  };
  readonly now: Date;
}

export interface BridgeGuardianReservedCommand {
  readonly requestId: string;
  readonly deviceId: string;
  readonly ownerAccountId: string;
  readonly preferenceRevision: string;
  readonly desiredMode: 'auto' | 'on' | 'off';
  readonly expiresAt: string;
  /**
   * Pure policy result. This is NOT a Windows Scheduled Task handle,
   * privileged command, local approval token or proof of execution.
   */
  readonly state: 'reserved-for-verified-local-processing';
}

export type BridgeGuardianAtomicReserve = (
  requestId: string,
  deviceId: string,
  credentialBinding: string,
  preferenceRevision: string,
) => Promise<boolean>;

const REVISION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The Guardian must have a separate lifecycle/transport from the Broker:
 * OFF disables the Broker's every-minute recovery trigger, so a Broker-only
 * management channel can never safely guarantee a future remote ON.
 *
 * No OS mutations are performed here. The atomic reserve callback MUST
 * compare current owner preference, pairing and device mode transactionally,
 * and MUST be durable across Guardian/Hub restart.
 */
export async function reserveVerifiedGuardianCommand(
  rawIntent: unknown,
  trustedRead: () => Promise<BridgeGuardianTrustedFacts>,
  atomicReserve: BridgeGuardianAtomicReserve,
): Promise<BridgeGuardianReservedCommand> {
  const facts = await trustedRead();
  const intent: AdminBridgeModeIntent = validateAdminBridgeModeIntent(rawIntent, {
    deviceId: facts.deviceId,
    ownerAccountId: facts.ownerAccountId,
    credentialBinding: facts.credentialBinding,
    now: facts.now,
    // Atomic replay checks occur in atomicReserve below.
    hasConsumedRequestId: () => false,
  });

  const preference=facts.currentPreference;
  const assertStillTrusted=(facts:BridgeGuardianTrustedFacts):void=>{
  if (facts.platform !== 'win32' || facts.accessMode !== 'full') {
    throw new Error('BRIDGE_GUARDIAN_DEVICE_NOT_ELIGIBLE');
  }
  const observedPreference=facts.currentPreference;
  if (!REVISION_PATTERN.test(observedPreference.revision) ||
      observedPreference.revision !== preference.revision ||
      observedPreference.desiredMode !== intent.desiredMode ||
      !facts.ownerApproval ||
      facts.ownerApproval.requestId !== intent.requestId ||
      facts.ownerApproval.preferenceRevision !== preference.revision) {
    throw new Error('BRIDGE_GUARDIAN_OWNER_APPROVAL_INVALID');
  }

  const guardian = facts.localGuardian;
  if (!guardian.installed ||
      !guardian.online ||
      !guardian.independentlyReachableWithBrokerOff ||
      !guardian.protectedSourceVerified ||
      !guardian.taskIdentityVerified ||
      !guardian.elevatedLocalTokenVerified ||
      !guardian.hubTransportAuthenticated ||
      !guardian.currentDeviceSessionVerified) {
    throw new Error('BRIDGE_GUARDIAN_INDEPENDENCE_OR_TRUST_UNVERIFIED');
  }

  // OFF can be used to contain a compromised/unhealthy Broker. Enabling or
  // starting it, however, always requires trusted task/launcher provenance.
  if (intent.desiredMode !== 'off' &&
      (!facts.broker.canonicalTaskIdentityVerified ||
       !facts.broker.launcherAclVerified)) {
    throw new Error('BRIDGE_GUARDIAN_BROKER_START_UNTRUSTED');
  }
  };
  assertStillTrusted(facts);

  const reserved = await atomicReserve(
    intent.requestId,
    intent.deviceId,
    intent.credentialBinding,
    preference.revision,
  );
  if (!reserved) throw new Error('BRIDGE_GUARDIAN_ALREADY_CONSUMED_OR_REVOKED');

  // A pending disk reservation can outlive the signed command, owner grant,
  // paired session or Guardian health. Re-read trusted facts from the source;
  // a consumed request must remain consumed when authorization expires.
  const current=await trustedRead();
  validateAdminBridgeModeIntent(intent,{
    deviceId:current.deviceId,
    ownerAccountId:current.ownerAccountId,
    credentialBinding:current.credentialBinding,
    now:current.now,hasConsumedRequestId:()=>false,
  });
  assertStillTrusted(current);

  return Object.freeze({
    requestId: intent.requestId,
    deviceId: intent.deviceId,
    ownerAccountId: intent.ownerAccountId,
    preferenceRevision: preference.revision,
    desiredMode: intent.desiredMode,
    expiresAt: intent.expiresAt,
    state: 'reserved-for-verified-local-processing' as const,
  });
}
