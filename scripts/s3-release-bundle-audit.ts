/**
 * S3 operator-only OFFLINE cryptographic preflight.
 * Never executes an installer, changes services, calls live update.apply or
 * asserts a safe process/rollback deployment. The trust policy hash must be
 * obtained OUT OF BAND, not from the downloaded release.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import {
  inspectAgentHubCompatibility, verifyAgentRelease,
  type AgentRuntime, type PublisherInspection, type SignedRelease,
} from '../src/update/agent-lifecycle-manager.js';
import {
  inspectSignedWindowsBinary,
  type WindowsBinaryTrustPins,
} from './s3-windows-binary-trust.js';
import {
  inspectWindowsProtectedExecutableTree,
  type WindowsAclAudit,
} from './s3-windows-acl-preflight.js';

const SHA = z.string().regex(/^[a-f0-9]{64}$/);
const Identifier = z.string().regex(/^[A-Za-z0-9_.:@-]{1,128}$/);
const Semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const TrustedPolicy = z.object({
  schemaVersion: z.literal(1),
  trustedManifestPublicKeyPem: z.string().min(80).max(8192),
  trustedPublisher: z.string().min(3).max(128),
  trustedCertificateSha256: SHA,
  expectedOwnerAccountId: Identifier,
  expectedDeviceId: Identifier,
  installedAgentVersion: Semver,
  hubVersion: Semver,
  targetVersion: Semver,
  rollbackArtifactSha256: SHA,
  targetArtifactSha256: SHA,
  /** Independent pin for the standalone installation helper executable. */
  installerHelperSha256: SHA,
}).strict();

export interface ReleaseBundleAuditOptions {
  /** Must be a separately controlled release policy, not an asset in the release bundle. */
  trustedPolicyPath: string;
  trustedPolicySha256: string;
  bundleRoot: string;
}
export interface ReleaseBundleAuditResult {
  status: 'offline_artifacts_verified';
  targetArtifactSha256: string;
  rollbackArtifactSha256: string;
  installerHelperSha256: string;
  signedManifestAndAuthenticodeVerified: true;
  canaryApproved: false;
  productionApproved: false;
  /** No proof of immutable launcher bytes, native process ownership or crash recovery. */
  executionSafe: false;
}
export type BinaryInspector = (
  pins: WindowsBinaryTrustPins,
) => { fileSha256: string; certificateSha256: string; publisherSubject: string; status: string };
export type AclInspector = (root: string) => WindowsAclAudit;

class AuditError extends Error { constructor(public readonly code: string) { super(code); } }
function deny(code: string): never { throw new AuditError('S3_OFFLINE_' + code); }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const maxBinaryBytes = 256 * 1024 * 1024;

async function checkDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) deny('ABSOLUTE_PATH_REQUIRED');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) deny('DIRECTORY_UNTRUSTED');
  if (path.resolve(await realpath(directory)).toLowerCase() !==
      path.resolve(directory).toLowerCase()) deny('DIRECTORY_UNTRUSTED');
}

async function readStableFile(filename: string, sizeLimit: number): Promise<Buffer> {
  if (!path.isAbsolute(filename)) deny('ABSOLUTE_PATH_REQUIRED');
  const initial = await lstat(filename);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 ||
      initial.size < 1 || initial.size > sizeLimit) deny('FILE_UNTRUSTED');
  const fd = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.size !== initial.size || opened.dev !== initial.dev ||
        opened.ino !== initial.ino || opened.mtimeMs !== initial.mtimeMs) deny('FILE_CHANGED');
    const bytes = await fd.readFile();
    const closing = await fd.stat();
    const after = await lstat(filename);
    if (bytes.length !== initial.size || closing.size !== initial.size ||
        closing.mtimeMs !== initial.mtimeMs || after.isSymbolicLink() ||
        after.dev !== initial.dev || after.ino !== initial.ino ||
        after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) {
      deny('FILE_CHANGED');
    }
    return bytes;
  } finally { await fd.close(); }
}

async function loadRelease(root: string): Promise<SignedRelease> {
  await checkDirectory(root);
  const manifest = JSON.parse((await readStableFile(path.join(root, 'manifest.json'), 32*1024)).toString('utf8'));
  const signature = (await readStableFile(path.join(root, 'manifest.sig'), 1024)).toString('utf8').trim();
  const artifact = await readStableFile(path.join(root, 'installer.exe'), maxBinaryBytes);
  return {manifest, manifestSignature:signature, artifact};
}
function compareVersions(a:string,b:string):number {
  const l=a.split('.').map(Number),r=b.split('.').map(Number);
  if ([...l,...r].some(x=>!Number.isSafeInteger(x))) deny('VERSION_UNSAFE');
  for(let i=0;i<3;i++){if(l[i] !== r[i]) return l[i]! < r[i]! ? -1 : 1;}
  return 0;
}

/**
 * Production CLI uses *actual* Windows Get-AuthenticodeSignature via the
 * supplied default inspector; unit tests inject a harmless fixture inspector.
 * Even when this succeeds, the release is NOT cleared for deployment.
 */
export async function auditOfflineReleaseBundles(
  input: ReleaseBundleAuditOptions,
  inspectBinary: BinaryInspector = inspectSignedWindowsBinary,
  inspectAcl: AclInspector = inspectWindowsProtectedExecutableTree,
): Promise<ReleaseBundleAuditResult> {
  if (!SHA.safeParse(input.trustedPolicySha256).success) deny('POLICY_PIN_INVALID');
  await checkDirectory(path.dirname(input.trustedPolicyPath));
  const policyBytes = await readStableFile(input.trustedPolicyPath, 16*1024);
  if (hash(policyBytes) !== input.trustedPolicySha256) deny('POLICY_HASH_MISMATCH');
  const parsed = TrustedPolicy.safeParse(JSON.parse(policyBytes.toString('utf8')));
  if (!parsed.success) deny('POLICY_INVALID');
  const policy = parsed.data;
  await checkDirectory(input.bundleRoot);
  const targetRoot=path.join(input.bundleRoot, 'target');
  const rollbackRoot=path.join(input.bundleRoot, 'rollback');
  const helperRoot=path.join(input.bundleRoot, 'helper');
  // P0 #271: integrity of a signed binary is meaningless if unprivileged
  // users can replace its path or an imported executable before elevation.
  // Inspect all ancestors and the complete bounded target/rollback trees.
  // No ACL changes are made here, ever.
  for (const protectedRoot of [targetRoot, rollbackRoot, helperRoot]) {
    let audit: WindowsAclAudit;
    try { audit = inspectAcl(protectedRoot); }
    catch { deny('ACL_UNTRUSTED'); }
    if (audit?.status !== 'protected_tree_inspected' ||
        !Number.isSafeInteger(audit.inspectedNodes) || audit.inspectedNodes < 1 ||
        audit.p0LegacyRuntimeExposed !== false ||
        audit.executionSafe !== false || audit.productionApproved !== false) {
      deny('ACL_UNTRUSTED');
    }
  }
  await checkDirectory(helperRoot);
  const helperPath=path.join(helperRoot,'installer-helper.exe');
  const helperBytes=await readStableFile(helperPath,maxBinaryBytes);
  if(hash(helperBytes)!==policy.installerHelperSha256)deny('HELPER_HASH_MISMATCH');
  let helperInspection:ReturnType<BinaryInspector>;
  try {
    helperInspection=inspectBinary({
      filePath:helperPath,expectedSha256:policy.installerHelperSha256,
      expectedCertificateSha256:policy.trustedCertificateSha256,
      expectedPublisherSubject:policy.trustedPublisher,
    });
  }catch{deny('HELPER_SIGNATURE_UNTRUSTED');}
  if(helperInspection?.status!=='signature_verified' ||
      helperInspection.fileSha256!==policy.installerHelperSha256 ||
      helperInspection.certificateSha256!==policy.trustedCertificateSha256 ||
      helperInspection.publisherSubject!==policy.trustedPublisher)deny('HELPER_SIGNATURE_UNTRUSTED');
  const helperReadback=await readStableFile(helperPath,maxBinaryBytes);
  if(hash(helperReadback)!==policy.installerHelperSha256)deny('HELPER_CHANGED');
  const target=await loadRelease(targetRoot);
  const rollback=await loadRelease(rollbackRoot);
  if(target.manifest.artifactSha256 !== policy.targetArtifactSha256 ||
     rollback.manifest.artifactSha256 !== policy.rollbackArtifactSha256) deny('ARTIFACT_POLICY_MISMATCH');
  if(target.manifest.version !== policy.targetVersion ||
     rollback.manifest.version !== policy.installedAgentVersion ||
     compareVersions(policy.targetVersion,policy.installedAgentVersion)<=0) {
    deny('VERSION_POLICY_MISMATCH');
  }
  const existingRuntime:AgentRuntime={
    ownerAccountId:policy.expectedOwnerAccountId,deviceId:policy.expectedDeviceId,
    agentVersion:policy.installedAgentVersion,hubVersion:policy.hubVersion,
    brokerMode:'off',coreGrantId:null,privilegeMode:'safe',
    authSessionEpoch:'offline-unverified-epoch',authTokenValid:false,
  };
  if (inspectAgentHubCompatibility(target.manifest,existingRuntime)!=='compatible' ||
      inspectAgentHubCompatibility(rollback.manifest,existingRuntime)!=='compatible') {
    deny('HUB_CONTRACT_MISMATCH');
  }
  for(const [label,release,root] of [
    ['target',target,targetRoot],['rollback',rollback,rollbackRoot],
  ] as const){
    const filename=path.join(root, 'installer.exe');
    await verifyAgentRelease(release,{
      trustedManifestPublicKeyPem:policy.trustedManifestPublicKeyPem,
      trustedPublisher:policy.trustedPublisher,
      trustedCertificateSha256:policy.trustedCertificateSha256,
      inspectPublisher:async (bytes):Promise<PublisherInspection>=>{
        const expectedSha256=hash(bytes);
        const evidence=inspectBinary({
          filePath:filename, expectedSha256,
          expectedCertificateSha256:policy.trustedCertificateSha256,
          expectedPublisherSubject:policy.trustedPublisher,
        });
        if (evidence.status !== 'signature_verified' ||
            evidence.fileSha256 !== expectedSha256 ||
            evidence.certificateSha256 !== policy.trustedCertificateSha256 ||
            evidence.publisherSubject !== policy.trustedPublisher) deny('AUTHENTICODE_MISMATCH');
        // Never infer process identity or TOCTOU-safe launch from this inspection.
        return {signatureValid:true,publisher:evidence.publisherSubject,
          artifactSha256:evidence.fileSha256,
          certificateSha256:evidence.certificateSha256};
      },
    });
    // Detect policy changes during inspection, including same-size replacements.
    const checked = await readStableFile(filename,maxBinaryBytes);
    if(hash(checked)!==release.manifest.artifactSha256)deny('ARTIFACT_CHANGED');
    if(label==='target' && compareVersions(release.manifest.version,rollback.manifest.version)<=0) {
      deny('TARGET_NOT_NEWER');
    }
  }
  const policyAfter=await readStableFile(input.trustedPolicyPath,16*1024);
  if(!policyBytes.equals(policyAfter))deny('POLICY_CHANGED');
  return {
    status:'offline_artifacts_verified',
    targetArtifactSha256:policy.targetArtifactSha256,
    rollbackArtifactSha256:policy.rollbackArtifactSha256,
    installerHelperSha256:policy.installerHelperSha256,
    signedManifestAndAuthenticodeVerified:true,
    canaryApproved:false,productionApproved:false,executionSafe:false,
  };
}
