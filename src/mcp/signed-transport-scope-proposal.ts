import {
  createHash, createPrivateKey, createPublicKey,
  sign as edSign, verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import type { LocalFirstTransportBudgetHook } from './all-ingress-transport-meter-proposal.js';

const AUDIENCE='nexowire-local-first-mcp';
const MAX_LIFETIME_MS=15*60_000;
const CLOCK_TOLERANCE_MS=30_000;
const NAME=/^[A-Za-z0-9_:.@-]{8,128}$/;
const KEY=/^[A-Za-z0-9_.:-]{4,64}$/;
const URL_PATH='/mcp';

/**
 * STAGING ONLY. No OpenAI Secure MCP Tunnel caller identity is yet available
 * to the agent; an authoritative operator must authenticate that identity
 * BEFORE issuing an assertion. The customer must receive ONLY the public
 * verification key, never a private key or a user-controlled scope selector.
 */
export interface TrustedSignedTransportClaims {
  version:1;
  audience:'nexowire-local-first-mcp';
  issuer:string;
  keyId:string;
  tunnelId:string;
  callerKind:'application'|'user';
  callerId:string;
  publicResourceUrl:string;
  routeGeneration:number;
  issuedAtMs:number;
  expiresAtMs:number;
}
export interface SignedTransportRoute {
  claims:TrustedSignedTransportClaims;
  signatureBase64url:string;
}
export interface TrustedTransportScope {
  scopeId:string;
  expiresAtMs:number;
}
function finiteTime(t:Date):number {
  if(!(t instanceof Date)||!Number.isSafeInteger(t.getTime())){
    throw new Error('Trusted transport clock invalid');
  }
  return t.getTime();
}
function urlResource(value:string):string {
  if(typeof value!=='string')throw new Error('Transport MCP resource invalid');
  let u:URL;
  try {u=new URL(value)}catch{
    throw new Error('Transport MCP resource invalid');
  }
  if(u.protocol!=='https:'||u.pathname!==URL_PATH||u.username||
     u.password||u.search||u.hash||u.port || u.hostname.length<4){
    throw new Error('Transport requires exact HTTPS MCP resource');
  }
  return u.toString();
}
function claimsBytes(c:TrustedSignedTransportClaims):Buffer {
  // Canonical serialization is built from an EXPLICIT allowlist. Unexpected
  // fields are rejected and may not be used to override signed semantics.
  if(!c||typeof c!=='object'||Array.isArray(c)||
    Object.keys(c).sort().join('|')!==
    ['audience','callerId','callerKind','expiresAtMs','issuedAtMs',
      'issuer','keyId','publicResourceUrl','routeGeneration','tunnelId',
      'version'].sort().join('|')){
    throw new Error('Transport claims schema invalid');
  }
  if(c.version!==1||c.audience!==AUDIENCE ||
     !NAME.test(c.issuer)||!KEY.test(c.keyId)||
     !NAME.test(c.tunnelId)||!NAME.test(c.callerId)||
     (c.callerKind!=='application'&&c.callerKind!=='user')||
     !Number.isSafeInteger(c.routeGeneration)||c.routeGeneration<1||
     !Number.isSafeInteger(c.issuedAtMs)||
     !Number.isSafeInteger(c.expiresAtMs)||
     c.expiresAtMs<=c.issuedAtMs ||
     c.expiresAtMs-c.issuedAtMs>MAX_LIFETIME_MS){
    throw new Error('Transport claims rejected');
  }
  urlResource(c.publicResourceUrl);
  return Buffer.from(JSON.stringify([
    c.version,c.audience,c.issuer,c.keyId,c.tunnelId,c.callerKind,
    c.callerId,c.publicResourceUrl,c.routeGeneration,c.issuedAtMs,c.expiresAtMs,
  ]),'utf8');
}
function requiredEd25519(key:KeyObject,kind:'public'|'private'){
  if(key.asymmetricKeyType!=='ed25519'||key.type!==kind){
    throw new Error('Operator route key must be Ed25519 '+kind);
  }
}
/** DEV-only issuer. Production issuer must run behind trusted operator auth. */
export function issueOperatorRouteAttestation(
  claims:TrustedSignedTransportClaims,privateKeyPem:string,
):SignedTransportRoute {
  const content=claimsBytes(claims);
  const key=createPrivateKey(privateKeyPem);
  requiredEd25519(key,'private');
  return {claims,signatureBase64url:edSign(null,content,key).toString('base64url')};
}
export function verifyOperatorRouteAttestation(input:{
  route:SignedTransportRoute;
  operatorPublicKeyPem:string;
  expectedIssuer:string;
  expectedKeyId:string;
  expectedPublicResourceUrl:string;
  minimumRouteGeneration:number;
  now:Date;
}):TrustedTransportScope {
  const at=finiteTime(input.now);
  const claims=input.route?.claims;
  const content=claimsBytes(claims);
  if(claims.issuer!==input.expectedIssuer ||
    claims.keyId!==input.expectedKeyId ||
    claims.publicResourceUrl!==urlResource(input.expectedPublicResourceUrl) ||
    !Number.isSafeInteger(input.minimumRouteGeneration) ||
    input.minimumRouteGeneration<1 ||
    claims.routeGeneration<input.minimumRouteGeneration ||
    at<claims.issuedAtMs-CLOCK_TOLERANCE_MS ||
    at>=claims.expiresAtMs){
    throw new Error('Transport attestation no longer authorized for this route');
  }
  const sig=input.route.signatureBase64url;
  if(typeof sig!=='string'||!(/^[A-Za-z0-9_-]{86}$/.test(sig))){
    throw new Error('Invalid Ed25519 transport signature encoding');
  }
  const pub=createPublicKey(input.operatorPublicKeyPem);
  requiredEd25519(pub,'public');
  if(!edVerify(null,content,pub,Buffer.from(sig,'base64url'))){
    throw new Error('Transport route signature invalid');
  }
  // No raw tunnel/account/application identifiers appear in emitted quota
  // scopes, logs or database filenames. Domain-separated deterministic scope.
  const scopeId='tr_'+createHash('sha256').update(JSON.stringify([
    'nexowire-transport-budget-v1',claims.issuer,claims.tunnelId,
    claims.callerKind,claims.callerId,
  ])).digest('hex');
  return {scopeId,expiresAtMs:claims.expiresAtMs};
}

/**
 * Bind one dedicated origin to ONE owner-signed route scope. Reverify
 * signature, expiry and minimum route generation on EVERY inbound request.
 * This DOES NOT authenticate individual MCP bearers or assert that the
 * upstream provider truly issued a tunnel/caller identity.
 */
export function createSignedStagingTransportBudget(input:{
  route:SignedTransportRoute;
  operatorPublicKeyPem:string;
  expectedIssuer:string;
  expectedKeyId:string;
  expectedPublicResourceUrl:string;
  /** Trusted operator epoch accessor, refreshed before EACH request. */
  minimumRouteGeneration:()=>number;
  meter:LocalFirstTransportBudgetHook['meter'];
  clock?:()=>Date;
}):LocalFirstTransportBudgetHook {
  const clock=input.clock??(()=>new Date());
  const verification=()=>verifyOperatorRouteAttestation({
    route:input.route,operatorPublicKeyPem:input.operatorPublicKeyPem,
    expectedIssuer:input.expectedIssuer,expectedKeyId:input.expectedKeyId,
    expectedPublicResourceUrl:input.expectedPublicResourceUrl,
    minimumRouteGeneration:input.minimumRouteGeneration(),now:clock(),
  });
  const scope=verification().scopeId;
  return {
    trustedScope:scope,
    clock,
    meter:{
      observe(givenScope,at){
        const fresh=verifyOperatorRouteAttestation({
          route:input.route,operatorPublicKeyPem:input.operatorPublicKeyPem,
          expectedIssuer:input.expectedIssuer,expectedKeyId:input.expectedKeyId,
          expectedPublicResourceUrl:input.expectedPublicResourceUrl,
          minimumRouteGeneration:input.minimumRouteGeneration(),now:at,
        });
        if(givenScope!==scope || fresh.scopeId!==scope){
          throw new Error('Signed transport scope mismatch');
        }
        return input.meter.observe(scope,at);
      },
    },
  };
}
