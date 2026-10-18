import type {AgentOperationRecord} from '../agent/operation-journal.js';
import type {IdempotencyRecord,IdempotencyStatus} from './idempotency-store.js';

export type ReconciliationState =
  | 'agent_confirmed' | 'agent_in_progress' | 'unknown';
export interface AgentOperationAssessment {
  readonly operationId:string;
  readonly hubStatus:IdempotencyStatus|'not_recorded';
  readonly state:ReconciliationState;
  readonly agentStatus?:AgentOperationRecord['status'];
  readonly evidenceKind?:AgentOperationRecord['evidenceKind'];
  readonly evidenceVerified:boolean;
  readonly externalSideEffectProven:boolean;
  readonly automaticallyRetryable:false;
  readonly reason:
    | 'agent_offline'|'agent_unavailable'|'record_missing'
    | 'journal_mismatch'|'in_progress'|'agent_terminal';
}

/**
 * Read-only reconciliation of two independent journals. The only trusted
 * terminal observation is an Agent record matching the EXACT request UUID,
 * capability and independently calculated Agent fingerprint. Hub-only
 * records, even 'succeeded', do not attest the external OS postcondition.
 *
 * No path can conclude that a missing Agent row means the action never ran.
 */
export function reconcileAgentOperation(input:{
  operationId:string;
  capability:string;
  fingerprint:string;
  hubRecord?:Pick<IdempotencyRecord,'operationId'|'capability'|'status'>;
  agentOnline:boolean;
  agentAvailable?:boolean;
  agentRecord?:AgentOperationRecord;
}):AgentOperationAssessment{
  const {operationId,capability,fingerprint,hubRecord,agentRecord}=input;
  const hubStatus:IdempotencyStatus|'not_recorded'=
    hubRecord?.operationId===operationId &&
    hubRecord.capability===capability?hubRecord.status:'not_recorded';
  const base={operationId,hubStatus,automaticallyRetryable:false as const,
    evidenceVerified:false,externalSideEffectProven:false};
  if(!input.agentOnline)return {...base,state:'unknown',reason:'agent_offline'};
  if(input.agentAvailable===false){
    return {...base,state:'unknown',reason:'agent_unavailable'};
  }
  if(!agentRecord)return {...base,state:'unknown',reason:'record_missing'};
  if(agentRecord.requestId!==operationId ||
     agentRecord.capability!==capability ||
     agentRecord.fingerprint!==fingerprint){
    return {...base,state:'unknown',reason:'journal_mismatch'};
  }
  if(agentRecord.status==='in_progress'){
    return {...base,state:'agent_in_progress',agentStatus:'in_progress',
      reason:'in_progress'};
  }
  if(agentRecord.status==='unknown'){
    return {...base,state:'unknown',agentStatus:'unknown',reason:'agent_terminal'};
  }
  // A shell exit is process evidence, not proof of what the command did.
  // File write ACK is not fsync/readback; service response alone does not
  // independently establish the changed state. Never claim OS exactly-once.
  return {
    ...base,
    state:'agent_confirmed',
    agentStatus:agentRecord.status,
    ...(agentRecord.evidenceKind?{evidenceKind:agentRecord.evidenceKind}:{}),
    evidenceVerified:agentRecord.evidenceVerified===true,
    reason:'agent_terminal',
  };
}
