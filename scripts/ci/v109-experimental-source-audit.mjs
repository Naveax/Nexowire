import { readFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPERIMENTAL_VERSION = '1.0.9-exp.0';
export const EXPERIMENTAL_TAG = 'v1.0.9-exp.0';
export const REQUIRED_SOURCE_FILES = Object.freeze({
  ownerCoreCli: 'src/agent/local-owner-core-cli.ts',
  coreAdmission: 'src/agent/windows-core-console-provider.ts',
  privilegedBroker: 'src/agent/privileged-broker.ts',
  nativeAgent: 'src/agent/native-agent.ts',
  systemCutover: 'src/hub/system-cutover-orchestrator.ts',
  aiScreen: 'src/agent/windows-private-screen.ts',
  displayPlanning: 'src/agent/windows-private-display-plan.ts',
  largeTransferPlanning: 'src/product/owner-public-wss-stream-flow-proposal.ts',
  windowsBundle: 'scripts/build-windows-user-bundle.ts',
  cutoverOrchestrator: 'scripts/ai04-controlled-system-hub-cutover.ts',
});
export const CORE_PHYSICAL_GATES = Object.freeze([
  'ownerConsentedElevatedSession',
  'trustedProtectedRuntimeAndTask',
  'authenticatedElevatedBroker',
  'independentCoreAuthorityAndEffectReadback',
  'systemDpapiAndProtectedSqlite',
  'revokeAndReplayDenied',
  'rebootAndRollbackAccepted',
]);

const SHA = /^[a-f0-9]{40}$/;

export function assessExperimentalSource({
  version, lockVersion, rootLockVersion, sourceSha, presentFiles,
}) {
  const files = presentFiles instanceof Set ? presentFiles : new Set(presentFiles ?? []);
  const missingSources = Object.entries(REQUIRED_SOURCE_FILES)
    .filter(([, file]) => !files.has(file))
    .map(([capability]) => capability);
  const validVersion = version === EXPERIMENTAL_VERSION
    && lockVersion === version && rootLockVersion === version;
  const validSource = typeof sourceSha === 'string' && SHA.test(sourceSha);
  return {
    release: EXPERIMENTAL_TAG,
    channel: 'EXPERIMENTAL_PREVIEW',
    packageVersion: version,
    sourceSha,
    sourceReady: validVersion && validSource && missingSources.length === 0,
    missingSources,
    sourceCapabilityInventory: Object.fromEntries(
      Object.entries(REQUIRED_SOURCE_FILES)
        .map(([capability, file]) => [capability, {
          path: file,
          sourceFound: files.has(file),
          runtimeAccepted: false,
        }]),
    ),
    stablePublishAuthorized: false,
    publicReleasePublished: false,
    fullCoreAccessVerified: false,
    physicalCoreStatus: 'NOT_ATTESTED',
    physicalCoreRequirements: [...CORE_PHYSICAL_GATES],
    physicalAcceptance: 'NOT_RUN',
    testLaneSourceSha: 'af6a83b8474500b48fe663129f5f1df2beb63e3e',
    trackedTypeScriptTests: 635,
    approvedPortableTestFiles: 29,
    notRunInPortableLane: 606,
    warning: 'Source presence, a running task, and an experimental label are not proof of elevated CORE effects.',
  };
}

export function inspectExperimentalSource(rootDir) {
  const root = path.resolve(rootDir);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).trim();
  const presentFiles = new Set();
  for (const file of Object.values(REQUIRED_SOURCE_FILES)) {
    try {
      if (lstatSync(path.join(root, ...file.split('/'))).isFile()) {
        presentFiles.add(file);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return assessExperimentalSource({
    version: pkg.version,
    lockVersion: lock.version,
    rootLockVersion: lock.packages?.['']?.version,
    sourceSha,
    presentFiles,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 3 || process.argv[2] !== '--json') {
    process.stderr.write('Usage: node scripts/ci/v109-experimental-source-audit.mjs --json\n');
    process.exitCode = 2;
  } else {
    const report = inspectExperimentalSource(process.cwd());
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.sourceReady) process.exitCode = 2;
  }
}
