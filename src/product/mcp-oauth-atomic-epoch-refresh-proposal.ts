import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { D1DatabaseLike } from './d1-control-plane-store.js';

const hash = (token:string):string =>
  createHash('sha256').update(token,'utf8').digest('hex');
const random = (prefix:string):string =>
  prefix + randomBytes(32).toString('base64url');

/**
 * STAGING-ONLY OAuth epoch-bound token rotation.
 *
 * Unlike the old service's separate consumeRefreshToken() + issueTokens(),
 * this sends ONE SQL INSERT with a trigger that consumes the old refresh,
 * inserts both new tokens, and enforces the current unlocked owner epoch.
 *
 * There is deliberately no Worker route or production token issuer import.
 * Never retry an ambiguous commit: a successful but lost response may
 * consume the old credential, and the new raw credentials are unrecoverable.
 */
export class ProposedMcpOAuthEpochAtomicRefresh {
  constructor(private readonly deps:{
    db:D1DatabaseLike;
    resource:string; // trusted first-party OAuth resource, not request JSON
    now?:()=>Date;
  }) {}

  async rotate(input:{
    refreshToken:string;
    clientId:string;
    requestedResource:string;
  }):Promise<Readonly<{
    access_token:string;
    refresh_token:string;
    token_type:'Bearer';
    expires_in:number;
    scope:string;
  }>> {
    if(typeof input.refreshToken!=='string' ||
      !/^nwx_refresh_[A-Za-z0-9_-]{20,200}$/.test(input.refreshToken) ||
      typeof input.clientId!=='string' ||
      input.clientId.length<1 || input.clientId.length>512 ||
      /[\r\n\0]/.test(input.clientId) ||
      typeof input.requestedResource!=='string' ||
      input.requestedResource!==this.deps.resource) {
      throw new Error('Invalid OAuth refresh grant');
    }
    const now=(this.deps.now??(()=>new Date()))();
    if(!(now instanceof Date)||!Number.isFinite(now.getTime())){
      throw new Error('OAuth refresh clock unavailable');
    }

    const prior=await this.deps.db.prepare(
      'SELECT account_id,client_id,resource,scopes_json,session_epoch,expires_at,revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash=?',
    ).bind(hash(input.refreshToken)).first<{
      account_id:string;
      client_id:string;
      resource:string;
      scopes_json:string;
      session_epoch:number;
      expires_at:string;
      revoked_at:string|null;
    }>();
    if(!prior || prior.client_id!==input.clientId ||
      prior.resource!==this.deps.resource || prior.revoked_at!==null ||
      !Number.isSafeInteger(prior.session_epoch) || prior.session_epoch<0 ||
      !Number.isFinite(Date.parse(prior.expires_at)) ||
      Date.parse(prior.expires_at)<=now.getTime()) {
      throw new Error('OAuth refresh credential unavailable');
    }
    let scopes:unknown;
    try{scopes=JSON.parse(prior.scopes_json)}catch{
      throw new Error('Invalid OAuth refresh scope record');
    }
    if(!Array.isArray(scopes) || !scopes.every(
      s=>typeof s==='string'&&['mcp','offline_access'].includes(s)) ||
      !scopes.includes('mcp') || !scopes.includes('offline_access')) {
      throw new Error('Invalid OAuth refresh scope record');
    }

    const epoch=await this.deps.db.prepare(
      'SELECT generation,locked FROM mcp_oauth_session_epochs WHERE account_id=?',
    ).bind(prior.account_id).first<{generation:number;locked:number}>();
    if(!epoch || epoch.locked!==0 ||
      !Number.isSafeInteger(epoch.generation) ||
      epoch.generation!==prior.session_epoch){
      throw new Error('OAuth refresh session epoch unavailable');
    }

    const accessToken=random('nwx_mcp_');
    const nextRefreshToken=random('nwx_refresh_');
    const rotatedAt=now.toISOString();
    const accessExpiresAt=new Date(now.getTime()+60*60*1000).toISOString();
    const refreshExpiresAt=new Date(now.getTime()+30*24*60*60*1000).toISOString();
    const result=await this.deps.db.prepare(
      'INSERT INTO mcp_oauth_epoch_refresh_rotations (operation_id,old_refresh_hash,account_id,client_id,resource,scopes_json,session_epoch,rotated_at,new_access_hash,new_refresh_hash,access_expires_at,refresh_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      randomUUID(),hash(input.refreshToken),prior.account_id,
      prior.client_id,prior.resource,prior.scopes_json,prior.session_epoch,
      rotatedAt,hash(accessToken),hash(nextRefreshToken),accessExpiresAt,
      refreshExpiresAt,
    ).run();

    if(result.success===false || !Number.isSafeInteger(result.meta?.changes) ||
      Number(result.meta?.changes)<1){
      // May have committed remotely. Never return token material or attempt
      // a second mutation after a missing acknowledgement.
      throw new Error('OAuth refresh rotation not acknowledged');
    }
    return {
      access_token:accessToken,refresh_token:nextRefreshToken,
      token_type:'Bearer',expires_in:3600,scope:scopes.join(' '),
    };
  }
}
