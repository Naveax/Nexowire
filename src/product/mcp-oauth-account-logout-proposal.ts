import type {D1DatabaseLike} from './d1-control-plane-store.js';

/**
 * S1 DEV-ONLY destructive session-logout experiment. Never wired to production.
 * This is a lockdown, NOT a complete reauthentication/session-family design:
 * after logout all new OAuth grants for this account remain unavailable.
 * Caller account ID must come from a trusted authenticated owner session.
 */
export class ProposedMcpOAuthAccountLogout {
  constructor(private readonly db:D1DatabaseLike){}

  async revokeAuthenticated(input:{
    authenticatedAccountId:string;
    targetAccountId:string;
    logoutId:string;
    at:Date;
  }):Promise<'revoked'|'already-revoked'|'denied'> {
    const idPattern=/^[A-Za-z0-9_.:-]{1,128}$/;
    const logoutPattern=/^[A-Za-z0-9_.:-]{8,128}$/;
    if(typeof input.authenticatedAccountId!=='string' ||
       !idPattern.test(input.authenticatedAccountId) ||
       typeof input.targetAccountId!=='string' ||
       !idPattern.test(input.targetAccountId) ||
       typeof input.logoutId!=='string' || !logoutPattern.test(input.logoutId) ||
       !(input.at instanceof Date) || !Number.isFinite(input.at.getTime())){
      throw new Error('Invalid trusted OAuth logout input');
    }
    if(input.authenticatedAccountId!==input.targetAccountId) return 'denied';
    const existing=async():Promise<boolean>=>{
      const row=await this.db.prepare(
        'SELECT logout_id FROM mcp_oauth_account_logout_gate WHERE account_id = ?',
      ).bind(input.targetAccountId).first<{logout_id:string}>();
      return row!==null;
    };
    if(await existing())return 'already-revoked';
    try{
      const result=await this.db.prepare(
        'INSERT INTO mcp_oauth_account_logout_gate (account_id,logout_id,revoked_at) VALUES (?,?,?)',
      ).bind(input.targetAccountId,input.logoutId,input.at.toISOString()).run();
      if(result.success===false || !Number.isSafeInteger(result.meta?.changes) ||
        Number(result.meta?.changes)<1) throw new Error('Unacknowledged account logout');
      return 'revoked';
    }catch(error){
      // If a remote write may have committed, return terminal revoked state,
      // NEVER a permit to execute or a signal to retry mutation.
      if(await existing())return 'already-revoked';
      throw error;
    }
  }
}
