import * as z from 'zod';
import type {AgentOperationRecord} from './operation-journal.js';

/**
 * #780 P1 inventory-only contract. This is a metadata projection, NOT a
 * mutation executor, checkpoint store, grant verifier, or replay authority.
 * It deliberately exposes no EXECUTE/RETRY action.
 */
const uuid=z.string().uuid();
const sha256=z.string().regex(/^[a-f0-9]{64}$/);
export const AgentLoopCheckpointV1Schema=z.strictObject({
  version:z.literal(1),
  taskId:z.string().min(1).max(128),
  stepId:z.string().min(1).max(128),
  requestId:uuid,
  fingerprint:sha256,
  capability:z.string().min(1).max(128),
  ownerId:uuid,
  deviceId:uuid,
  deviceEpoch:uuid,
  sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),
  grantGeneration:z.number().int().positive().safe(),
  sourceSha:z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/).optional(),
  state:z.enum([
    'PLANNED','RESERVED','DISPATCH_MAY_HAVE_OCCURRED',
    'RECONCILE_REQUIRED','LOCAL_TERMINAL_NEEDS_PROOF',
  ]),
  originalErrorCode:z.string().min(1).max(128).optional(),
}).strict();

export type AgentLoopCheckpointV1=Readonly<
  z.infer<typeof AgentLoopCheckpointV1Schema>
>;
export type AgentLoopReadOnlyDecision=Readonly<{
  requestId:string;
  state:'RECONCILE_REQUIRED'|'READ_ONLY_INSPECTION'|'SCOPE_MISMATCH';
  reason:
    | 'IMMUTABLE_REQUEST_SCOPE_CHANGED'
    | 'JOURNAL_SCOPE_MISMATCH'
    | 'JOURNAL_ROW_MISSING'
    | 'UNKNOWN_OR_POSSIBLY_DISPATCHED'
    | 'LOCAL_TERMINAL_NOT_INDEPENDENT_PROOF'
    | 'AUTHORITY_CHECK_REQUIRED';
  originalErrorCode?:string;
  nextAction:'READ_ONLY_RECONCILIATION'|'READ_ONLY_INSPECTION'|'STOP';
  mayReplay:false;
  mayDispatch:false;
  completedVerified:false;
}>;

const immutableFields=[
  'taskId','stepId','requestId','fingerprint','capability','ownerId',
  'deviceId','deviceEpoch','sessionEpoch','ownerEpoch','grantGeneration',
] as const;

/**
 * Pure and intentionally conservative: an Agent journal or checkpoint can
 * describe an outcome, but cannot attest rollback-independent authority,
 * current protected Broker admission, or the external OS side effect.
 * The caller is responsible for separate trusted readback, NEVER blind replay.
 */
export function reviewAgentLoopCheckpoint(
  input:unknown,
  journal?:Pick<AgentOperationRecord,
    'requestId'|'fingerprint'|'capability'|'status'|'dispatchedAt'|
    'evidenceVerified'>,
  previous?:AgentLoopCheckpointV1,
):AgentLoopReadOnlyDecision{
  const cp=AgentLoopCheckpointV1Schema.parse(input);
  const result=(
    state:AgentLoopReadOnlyDecision['state'],
    reason:AgentLoopReadOnlyDecision['reason'],
    nextAction:AgentLoopReadOnlyDecision['nextAction'],
  ):AgentLoopReadOnlyDecision=>Object.freeze({
    requestId:cp.requestId,state,reason,nextAction,
    ...(cp.originalErrorCode?
      {originalErrorCode:cp.originalErrorCode}:{}),
    mayReplay:false as const,mayDispatch:false as const,
    completedVerified:false as const,
  });
  if(previous && immutableFields.some(key=>previous[key]!==cp[key]))
    return result('SCOPE_MISMATCH','IMMUTABLE_REQUEST_SCOPE_CHANGED','STOP');
  if(journal && (journal.requestId!==cp.requestId||
      journal.fingerprint!==cp.fingerprint||
      journal.capability!==cp.capability))
    return result('SCOPE_MISMATCH','JOURNAL_SCOPE_MISMATCH','STOP');
  if(!journal)
    return result('RECONCILE_REQUIRED','JOURNAL_ROW_MISSING',
      'READ_ONLY_RECONCILIATION');
  if(cp.state==='RECONCILE_REQUIRED'||
     cp.state==='DISPATCH_MAY_HAVE_OCCURRED'||
     journal.status==='unknown'||journal.status==='in_progress'||
     journal.dispatchedAt!==undefined||
     cp.originalErrorCode==='MUTATION_STATE_UNKNOWN')
    return result('RECONCILE_REQUIRED','UNKNOWN_OR_POSSIBLY_DISPATCHED',
      'READ_ONLY_RECONCILIATION');
  if(journal.status==='succeeded'||journal.status==='failed')
    return result('READ_ONLY_INSPECTION',
      'LOCAL_TERMINAL_NOT_INDEPENDENT_PROOF','READ_ONLY_INSPECTION');
  return result('READ_ONLY_INSPECTION',
    'AUTHORITY_CHECK_REQUIRED','READ_ONLY_INSPECTION');
}
