/**
 * Pure, fail-closed *candidate* ACL analysis for cross-PR #551/#576 evidence.
 * Collected samples are caller-supplied data, NEVER proof of Windows
 * AccessCheck, elevated token identity, installed file handles, or authority.
 * Production trust requires a separate privileged read-only physical observer.
 */
export type ProtectedSourceRole='private-parent'|'updater-parent'|'updater'|
  'broker-launcher'|'broker-binary'|'job-helper'|'job-helper-manifest';

export interface CapturedProtectedSourceAcl {
  role:ProtectedSourceRole;
  canonicalPath:string;
  ownerSid:string;
  identityVerified:boolean;
  aclReadSucceeded:boolean;
  reparsePoint:boolean;
  /** These are ACL entries, not the result of native Windows AccessCheck. */
  accessRules:ReadonlyArray<{
    sid:string;type:'Allow'|'Deny';rights:number;inherited:boolean;
  }>;
}

const ROLES:ReadonlyArray<ProtectedSourceRole>=[
  'private-parent','updater-parent','updater','broker-launcher',
  'broker-binary','job-helper','job-helper-manifest',
];
const TRUSTED=new Set(['S-1-5-18','S-1-5-32-544']);
const DANGEROUS=(0x0002|0x0004|0x0010|0x0040|0x0100|
  0x10000|0x40000|0x80000|0x10000000|0x40000000)>>>0;

export type CandidateAclResult=Readonly<{
  status:'BLOCKED'|'CANDIDATE_SAFE_ONLY';
  productionApproved:false;
  independentEffectiveAccessVerified:false;
  checkedRoles:number;
  errors:ReadonlyArray<string>;
}>;
export function evaluateCandidateProtectedSourceAcls(
  samples:readonly CapturedProtectedSourceAcl[],
):CandidateAclResult {
  const errors:string[]=[];
  const seen=new Set<string>();
  if(!Array.isArray(samples)||samples.length!==ROLES.length){
    errors.push('SOURCE_CHAIN_INCOMPLETE');
  }
  for(const role of ROLES){
    const nodes=Array.isArray(samples)?samples.filter(s=>s?.role===role):[];
    if(nodes.length!==1){
      errors.push('SOURCE_ROLE_MISSING_OR_DUPLICATE:'+role);
      continue;
    }
    const s=nodes[0]!;
    const path=s.canonicalPath;
    if(typeof path!=='string' || !/^[A-Za-z]:\\/.test(path) ||
      path.includes('..') || /[\x00-\x1f]/.test(path) ||
      seen.has(path.toLowerCase())){
      errors.push('SOURCE_CANONICAL_PATH_UNKNOWN:'+role);
    }else seen.add(path.toLowerCase());
    if(!s.identityVerified || !s.aclReadSucceeded || s.reparsePoint ||
      !TRUSTED.has(s.ownerSid)||!Array.isArray(s.accessRules)){
      errors.push('SOURCE_IDENTITY_OR_ACL_UNKNOWN:'+role);
      continue;
    }
    for(const ace of s.accessRules){
      if(!ace || !/^S-\d+(?:-\d+)+$/.test(ace.sid) ||
        !['Allow','Deny'].includes(ace.type) ||
        !Number.isSafeInteger(ace.rights) ||
        ace.rights < -0x80000000 || ace.rights > 0xffffffff ||
        typeof ace.inherited!=='boolean'){
        errors.push('SOURCE_ACL_ENTRY_MALFORMED:'+role);
        continue;
      }
      // Inheritance-only grants are conservatively unsafe because they can
      // propagate to a new child even when they don't apply to this object.
      if(ace.type==='Allow' && !TRUSTED.has(ace.sid) &&
        (((ace.rights>>>0)&DANGEROUS)>>>0)!==0){
        errors.push('UNTRUSTED_WRITE_OR_REPLACEMENT_ACE:'+role);
      }
    }
  }
  return Object.freeze({
    status:errors.length?'BLOCKED':'CANDIDATE_SAFE_ONLY',
    productionApproved:false,
    independentEffectiveAccessVerified:false,
    checkedRoles:seen.size,
    errors:Object.freeze(errors),
  });
}
