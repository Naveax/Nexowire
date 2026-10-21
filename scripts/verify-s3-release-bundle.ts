/**
 * S3 preflight CLI: verifies offline evidence only; NEVER installs/executes.
 *
 * Example:
 * npm run s3:release-preflight -- --trusted-policy "C:\trusted\policy.json"
 *   --policy-sha256 <independently pinned digest> --bundle-root "C:\release"
 *
 * The trusted policy MUST be independently delivered and pinned. Downloading
 * the policy/hash from the same untrusted release does not establish trust.
 */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  auditOfflineReleaseBundles,
  type ReleaseBundleAuditOptions,
} from './s3-release-bundle-audit.js';

export function parseOfflineReleaseArgs(args:readonly string[]):ReleaseBundleAuditOptions{
  if(args.length!==6)throw new Error('S3_OFFLINE_ARGS_INVALID');
  const flags:Record<string,string>={};
  for(let i=0;i<args.length;i+=2){
    const option=args[i],value=args[i+1];
    if(!option||!['--trusted-policy','--policy-sha256','--bundle-root'].includes(option)||
      !value||value.startsWith('--')||Object.hasOwn(flags,option)){
      throw new Error('S3_OFFLINE_ARGS_INVALID');
    }
    flags[option]=value;
  }
  if(Object.keys(flags).length!==3)throw new Error('S3_OFFLINE_ARGS_INVALID');
  return {
    trustedPolicyPath:flags['--trusted-policy']!,
    trustedPolicySha256:flags['--policy-sha256']!,
    bundleRoot:flags['--bundle-root']!,
  };
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    const args=parseOfflineReleaseArgs(process.argv.slice(2));
    const result=await auditOfflineReleaseBundles(args);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(error){
    // Never echo untrusted paths, owner identity, credentials or manifest text.
    const message=error instanceof Error && /^S3_(OFFLINE|MANIFEST|ARTIFACT|BINARY)_[A-Z_]+$/.test(error.message)
      ? error.message : 'S3_OFFLINE_UNVERIFIED';
    process.stderr.write(message+'\n');
    process.exitCode=1;
  }
}
