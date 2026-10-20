import {
  validateOwnerPublicWssTrustProfile,
  type OwnerPublicWssTrustProfile,
} from './owner-public-wss-trust-proposal.js';

const HEX32=/^[a-f0-9]{32}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS=/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface NamedTunnelOfflineEvidence {
  /** Operator-provided metadata, NOT API-verified account ownership. */
  accountId?:string;
  zoneId?:string;
  tunnelId?:string;
  zoneName?:string;
  hostname?:string;
  edgeCertificateMode?:'cloudflare-managed'|'operator-custom';
  profile?:OwnerPublicWssTrustProfile;
}
export interface NamedTunnelOfflineResult {
  productionAccepted:false;
  stage:'BLOCKED'|'OFFLINE_PREFLIGHT_ONLY';
  missingOrInvalid:readonly string[];
  /** Mandatory authenticated, read-only evidence before promotion. */
  requiredLiveProof:readonly string[];
}
/**
 * NO CLOUD API CALLS, DNS changes, token reads or tunnel provisioning.
 * Valid-looking input is not proof of ownership or live WSS identity.
 */
export function inspectNamedTunnelOfflinePreflight(
  input:NamedTunnelOfflineEvidence|undefined,
):NamedTunnelOfflineResult{
  const e=input??{};
  const issues:string[]=[];
  if(!HEX32.test(e.accountId??''))issues.push('cloudflare_account_id_missing');
  if(!HEX32.test(e.zoneId??''))issues.push('cloudflare_zone_id_missing');
  if(!UUID.test(e.tunnelId??''))issues.push('named_tunnel_uuid_missing');
  const zone=e.zoneName??'',host=e.hostname??'';
  if(!DNS.test(zone)||zone.endsWith('.trycloudflare.com')){
    issues.push('operator_zone_name_missing_or_invalid');
  }
  if(!DNS.test(host)||host===zone||!host.endsWith('.'+zone)||
     host.endsWith('.trycloudflare.com')){
    issues.push('public_hostname_not_inside_operator_zone');
  }
  if(e.edgeCertificateMode!=='operator-custom'){
    issues.push('cloudflare_managed_edge_spki_rotation_unresolved');
  }
  try{
    const profile=validateOwnerPublicWssTrustProfile(e.profile!);
    if(profile.hostname!==host)issues.push('signed_profile_hostname_mismatch');
  }catch{
    issues.push('signed_profile_tls_trust_invalid');
  }
  const requiredLiveProof=[
    'Read-only authenticated Cloudflare account/zone/tunnel ownership and ingress target',
    'Independent DNS CNAME/tunnel route and Cloudflare Access policy validation',
    'Independently provisioned TLS1.3 hostname/SAN/CA and controlled SPKI rotation',
    'Operator signed profile, device/account/lease revocation and external-ISP acceptance',
    'Server-side native Broker grants/owner enforcement and failure rollback evidence',
  ];
  return {
    productionAccepted:false,
    stage:issues.length?'BLOCKED':'OFFLINE_PREFLIGHT_ONLY',
    missingOrInvalid:Object.freeze(issues),
    requiredLiveProof:Object.freeze(requiredLiveProof),
  };
}
