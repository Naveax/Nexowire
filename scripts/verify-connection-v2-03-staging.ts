/**
 * V2-03 isolated OAuth bearer -> MCP protocol acceptance.
 * No OAuth consent automation: the operator explicitly supplies a disposable
 * staging access token already issued by the expected issuer for the resource.
 * Never log bearer, response bodies or confidential tool output.
 *
 * NEXOWIRE_V2_STAGING_ACK=disposable-only
 * NEXOWIRE_V2_STAGING_RESOURCE=https://staging.example.test/mcp
 * NEXOWIRE_V2_STAGING_ISSUER=https://issuer-staging.example.test
 * NEXOWIRE_V2_STAGING_BEARER=<ephemeral authorized staging token>
 * NEXOWIRE_V2_STAGING_EXPECTED=<non-secret expected exact output marker>
 */
import {verifyConnectionV2AuthenticatedReadOnly} from '../src/mcp/cloudflare-connection-doctor.js';

async function main():Promise<void>{
  if(process.env.NEXOWIRE_V2_STAGING_ACK!=='disposable-only')
    throw Error('STAGING_EXPLICIT_DISPOSABLE_ACK_REQUIRED');
  const resourceUrl=process.env.NEXOWIRE_V2_STAGING_RESOURCE??'';
  const issuerUrl=process.env.NEXOWIRE_V2_STAGING_ISSUER??'';
  const bearerToken=process.env.NEXOWIRE_V2_STAGING_BEARER??'';
  const expectedOutputContains=process.env.NEXOWIRE_V2_STAGING_EXPECTED??'';
  // This script will NEVER accept HTTP loopback, real production overrides,
  // arbitrary tool selection, nor perform a mutation.
  const result=await verifyConnectionV2AuthenticatedReadOnly({
    resourceUrl,issuerUrl,bearerToken,expectedOutputContains,
    toolName:'nexowire_surface_info',timeoutMs:10000,
  });
  process.stdout.write(JSON.stringify({
    mode:'STAGING_ONLY',
    chatgptOauthConnect:'NOT_RUN',
    actualDeviceEnrollment:'NOT_RUN',
    externalNetworkMeasured:'NOT_RUN',
    ...result,
  })+'\n');
  if(result.stage!=='AUTHENTICATED_MCP_READY'||!result.authenticatedToolVerified)
    process.exitCode=1;
}
void main().catch(error=>{
  // Never echo a rejected URL, bearer or a raw provider/network error.
  process.stderr.write('NEXOWIRE_V2_STAGING_ACCEPTANCE_BLOCKED\n');
  process.exitCode=2;
});
