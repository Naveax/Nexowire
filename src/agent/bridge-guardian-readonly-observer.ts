import * as z from 'zod';
import {
  verifyBridgeGuardianSourceAcl,
  verifyBridgeGuardianTaskSnapshot,
} from './bridge-guardian-task-preflight.js';

/**
 * An inventory is diagnostic material, NEVER sufficient authority to run a
 * privileged Windows task. The separately protected Guardian Agent must
 * independently establish its own identity, pairing and channel.
 */
const inventoryReport = z.strictObject({
  auditOnly: z.literal(true),
  privilegedOperationPerformed: z.literal(false),
  installed: z.boolean(),
  lookupVerified: z.boolean(),
  status: z.enum(['ABSENT','AMBIGUOUS','UNVERIFIED','SNAPSHOT_ONLY']),
  currentUserSid: z.string().regex(/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/),
  snapshot: z.unknown().nullable(),
});

export type BridgeGuardianObservationStatus =
  | 'absent' | 'unverified' | 'untrusted-task'
  | 'task-identity-only' | 'source-acl-verified';

export interface BridgeGuardianReadOnlyObservation {
  readonly status: BridgeGuardianObservationStatus;
  readonly taskIdentityVerified: boolean;
  readonly sourceAclVerified: boolean;
  /** There is no authenticated Hub/Guardian channel established here. */
  readonly hubChannelVerified: false;
  /** Neither a task listing nor an ACL check authorizes OS actuation. */
  readonly remoteActuationAuthorized: false;
}

const MAX_INVENTORY_BYTES = 64 * 1024;
function result(
  status: BridgeGuardianObservationStatus,
  taskIdentityVerified = false,
  sourceAclVerified = false,
): BridgeGuardianReadOnlyObservation {
  return Object.freeze({
    status, taskIdentityVerified, sourceAclVerified,
    hubChannelVerified:false, remoteActuationAuthorized:false,
  });
}

/**
 * Parse one bounded report from the non-elevated read-only Windows inspector.
 * The report is untrusted even if it describes a running Highest task.
 *
 * A caller may opt into an independent read-only ACL verification. That check
 * does not change status to "ready": live user/elevation/channel attestation
 * and request-specific consent are entirely separate security boundaries.
 */
export function assessBridgeGuardianReadOnlyInventory(
  raw: string,
  options: {
    readonly expectedUserSid: string;
    readonly verifyProtectedSource?: () => void;
  },
): BridgeGuardianReadOnlyObservation {
  if (typeof raw !== 'string' ||
      Buffer.byteLength(raw,'utf8') > MAX_INVENTORY_BYTES ||
      raw.trim().length === 0) {
    throw new Error('BRIDGE_GUARDIAN_INVENTORY_TOO_LARGE_OR_EMPTY');
  }
  let parsed: unknown;
  try {
    parsed=JSON.parse(raw);
  } catch {
    throw new Error('BRIDGE_GUARDIAN_INVENTORY_INVALID_JSON');
  }
  const report=inventoryReport.parse(parsed);
  if (report.currentUserSid !== options.expectedUserSid) {
    throw new Error('BRIDGE_GUARDIAN_INVENTORY_USER_MISMATCH');
  }
  if (report.status === 'ABSENT') {
    if (report.installed || !report.lookupVerified || report.snapshot !== null) {
      throw new Error('BRIDGE_GUARDIAN_INVENTORY_INCONSISTENT');
    }
    return result('absent');
  }
  if (report.status === 'UNVERIFIED' || report.status === 'AMBIGUOUS') {
    if (report.installed || report.snapshot !== null ||
        (report.status === 'UNVERIFIED' && report.lookupVerified) ||
        (report.status === 'AMBIGUOUS' && report.lookupVerified)) {
      throw new Error('BRIDGE_GUARDIAN_INVENTORY_INCONSISTENT');
    }
    return result('unverified');
  }
  if (!report.installed || !report.lookupVerified || !report.snapshot) {
    throw new Error('BRIDGE_GUARDIAN_INVENTORY_INCONSISTENT');
  }
  try {
    verifyBridgeGuardianTaskSnapshot(report.snapshot,report.currentUserSid);
  } catch {
    return result('untrusted-task');
  }
  const verifySource = options.verifyProtectedSource ?? verifyBridgeGuardianSourceAcl;
  try {
    verifySource();
  } catch {
    return result('task-identity-only',true);
  }
  return result('source-acl-verified',true,true);
}
