import { createHash } from 'node:crypto';
import type { D1DatabaseLike } from './d1-control-plane-store.js';

export type ProposedToolAdmissionKind = 'read' | 'write';

export interface ProposedToolAdmission {
  accountId: string;
  clientId: string;
  deviceId: string;
  sessionEpoch: number;
  accessMode: 'safe' | 'full';
}

type AdmissionRow = {
  account_id: string;
  client_id: string;
  resource: string;
  scopes_json: string;
  expires_at: string;
  created_at: string;
  session_epoch: number;
  generation: number | null;
  locked: number | null;
  had_logout: string | null;
  had_transition: number;
  device_id: string;
  device_owner: string;
  online: number;
  access_mode: string;
};

/**
 * S1 DEV/STAGING only. One coherent SQL snapshot checks current OAuth
 * token, session epoch AND owner/device authorization. No production imports.
 *
 * This is a request-admission gate, NOT a lock held across an external
 * action. It cannot revoke an operation already running or guarantee
 * atomicity between the final check and a side effect.
 *
 * The server MUST classify tool kind independently from caller-supplied
 * arguments; request JSON must never be able to downgrade 'write' to 'read'.
 */
export class ProposedMcpOAuthEpochToolAdmission {
  constructor(private readonly deps: {
    db: D1DatabaseLike;
    resource: string;
    now?: () => Date;
  }) {}

  async check(input: {
    rawAccessToken: string;
    deviceId: string;
    kind: ProposedToolAdmissionKind;
  }): Promise<ProposedToolAdmission | null> {
    if (typeof input.rawAccessToken !== 'string' ||
        !/^nwx_mcp_[A-Za-z0-9_-]{1,500}$/.test(input.rawAccessToken) ||
        input.rawAccessToken.length > 512 ||
        typeof input.deviceId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.deviceId) ||
        (input.kind !== 'read' && input.kind !== 'write') ||
        typeof this.deps.resource !== 'string' ||
        !this.deps.resource) {
      return null;
    }
    const now=(this.deps.now??(()=>new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Trusted admission clock unavailable');
    }
    const tokenHash=createHash('sha256')
      .update(input.rawAccessToken,'utf8').digest('hex');

    const row=await this.deps.db.prepare(
      'SELECT t.account_id,t.client_id,t.resource,t.scopes_json,' +
      't.expires_at,t.created_at,t.session_epoch,' +
      'e.generation,e.locked,g.account_id AS had_logout,' +
      'EXISTS(SELECT 1 FROM mcp_oauth_session_epoch_events AS v ' +
      'WHERE v.account_id=t.account_id) AS had_transition,' +
      'd.id AS device_id,d.owner_account_id AS device_owner,' +
      'd.online,d.access_mode ' +
      'FROM mcp_oauth_access_tokens AS t ' +
      'JOIN devices AS d ON d.id=? AND d.owner_account_id=t.account_id ' +
      'LEFT JOIN mcp_oauth_session_epochs AS e ON e.account_id=t.account_id ' +
      'LEFT JOIN mcp_oauth_account_logout_gate AS g ON g.account_id=t.account_id ' +
      'WHERE t.token_hash=?',
    ).bind(input.deviceId,tokenHash).first<AdmissionRow>();

    if (!row ||
        typeof row.account_id!=='string' || !row.account_id ||
        typeof row.client_id!=='string' || !row.client_id ||
        row.device_id!==input.deviceId ||
        row.device_owner!==row.account_id ||
        row.resource!==this.deps.resource ||
        row.online!==1 ||
        (row.access_mode!=='safe' && row.access_mode!=='full') ||
        (input.kind==='write' && row.access_mode!=='full') ||
        !Number.isSafeInteger(row.session_epoch) || row.session_epoch<0 ||
        !Number.isFinite(Date.parse(row.expires_at)) ||
        Date.parse(row.expires_at)<=now.getTime() ||
        !Number.isFinite(Date.parse(row.created_at)) ||
        Date.parse(row.created_at)>now.getTime()) {
      return null;
    }
    if (row.generation===null) {
      if (row.session_epoch!==0 || row.locked!==null ||
          row.had_logout!==null || row.had_transition!==0) return null;
    } else if (!Number.isSafeInteger(row.generation) ||
               row.generation<0 || row.locked!==0 ||
               row.generation!==row.session_epoch) {
      return null;
    }
    let scopes:unknown;
    try {scopes=JSON.parse(row.scopes_json)}
    catch {return null}
    if (!Array.isArray(scopes) || scopes.length<1 || scopes.length>32 ||
        !scopes.every(s=>typeof s==='string' && s.length>0 &&
          s.length<=128) || !scopes.includes('mcp')) return null;

    return {
      accountId:row.account_id,
      clientId:row.client_id,
      deviceId:input.deviceId,
      sessionEpoch:row.session_epoch,
      accessMode:row.access_mode,
    };
  }

  /**
   * Two independent checks narrow the read-to-dispatch window. The optional
   * preDispatch callback is a TEST seam, not user-provided execution code.
   * When no second grant exists, the handler is never called. A revocation
   * after the second grant is still a live race and MUST be solved by
   * enforcement at the mutating side-effect boundary.
   */
  async dispatch<T>(input: {
    rawAccessToken: string;
    deviceId: string;
    kind: ProposedToolAdmissionKind;
  }, handler: (grant: ProposedToolAdmission) => Promise<T>,
  preDispatch?: () => Promise<void>): Promise<T> {
    const first=await this.check(input);
    if (!first) throw new Error('MCP tool admission denied');
    if (preDispatch) await preDispatch();
    const second=await this.check(input);
    if (!second ||
        second.accountId!==first.accountId ||
        second.clientId!==first.clientId ||
        second.sessionEpoch!==first.sessionEpoch ||
        second.deviceId!==first.deviceId) {
      throw new Error('MCP tool admission changed before dispatch');
    }
    return handler(second);
  }
}
