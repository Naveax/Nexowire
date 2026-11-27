# AI-05 Job owner release signing handoff — 2026-11-26

## Scope and verified evidence

Base #1369 head 155f876dd63732d9fa6126a30c62d09d8398e1b7; hosted PR merge checkout 479801f37d2f8c502b36935e9db46602fa486017. Release Readiness 45807856669 succeeded; Windows package job 139869697162, artifact 15113070819, outer Actions ZIP digest cf06b7294386a2f34e3824abd9d72807c0ed858ddee8e49aaa9ae90476b4597c. Attest and Publish skipped. User's earlier inspection reports the helper unsigned with matching package hashes; that is a staging package, not a signed release. Outer Actions ZIP digest is not the inner payload or helper digest.

#269 requires trusted Nexowire publisher, timestamp, archive SHA256, explicit owner consent and native bootstrap acceptance. #551 additionally requires independently pinned Ed25519 release manifests, exact signer subject and certificate DER SHA256, target and complete rollback bytes and held native process identity. Existing Setup.cmd is not a signed native installer. This patch addresses Job helper verification only; it does not satisfy the native installer, rollback archive, or one-click acceptance requirements.

## Narrow source change

Existing tag-scoped gate now requires configured publisher thumbprint, exact subject, certificate DER SHA256, independently approved **post-signing** artifact SHA256, and absolute approved Windows SDK SignTool path. Check embedded Authenticode Valid and timestamp certificate, then SignTool verify /pa /all /tw /v (exit 0 only; warnings fail). Check helper bytes against approved hash and adjacent post-signing SHA256 before and after verification; compare copied payload bytes and generate the staged sidecar from those bytes. Untagged PR builds remain staging-only but verify source and staged digest consistency. No signing or release/publish/deployment action added. Readback is not an OS-held native image identity or activation grant.

## Provisioning and sequence (operator approval required)

1. Release owner / security owner approves exact reviewed source commit, native build/toolchain and unsigned artifact provenance. Signing custodian provides trusted code-signing publication identity through approved HSM/cloud signing or equivalent protected service; never export or paste private key. Approve RFC3161 timestamp authority and SHA256 file/timestamp digest policy.
2. Authorized signing custodian signs the exact final native binary, timestamps it, and supplies independent approved final artifact SHA256 plus signer certificate DER SHA256, exact certificate subject and thumbprint through trusted release policy. No policy value is derived from the candidate and then used to approve itself. No unsigned digest may stand in for the signed digest.
3. Only after authorized signing, regenerate native/windows-job-owner.sha256 from the approved signed binary; require hash equality with the independently supplied pin. The existing compile script generates a PRE-signing hash; a subsequent signing operation changes the bytes. Do not rebuild after signing. Package builder rejects stale sidecar. Rebuild the ZIP and Setup.cmd and SHA256SUMS-Windows from the final signed payload; independently authenticate the release manifest and bind all final artifact hashes/source SHA. Do not edit or reuse the old uploaded artifact as a release.
4. Release engineering provisions the trusted SDK SignTool executable path and the public policy values in a protected tag/release job (not PR-controlled environment). Existing workflow has no production signing integration; coordinate with AI-00/AI-08. The approved signing step and independent verification job are external dependencies, not silently introduced here. No publication authorization marker or tag is created by this patch.

Required configuration (public policy, not secrets):
- NEXOWIRE_WINDOWS_JOB_PUBLISHER_THUMBPRINT (40 hex, existing compatibility pin)
- NEXOWIRE_WINDOWS_JOB_PUBLISHER_SUBJECT (exact approved subject)
- NEXOWIRE_WINDOWS_JOB_SIGNER_SHA256 (64 hex, DER certificate bytes)
- NEXOWIRE_WINDOWS_JOB_ARTIFACT_SHA256 (64 hex, independently approved final signed PE bytes)
- NEXOWIRE_WINDOWS_SIGNTOOL_PATH (absolute approved Windows SDK signtool.exe path; independent trusted tool installation)

## Independent read-only Windows verification

AI-08/AI-09 or an independent release verifier on a clean authorized Windows host, not the signing host, receives the final package, exact source and independently approved signed manifest/policy. Verify outer ZIP and Setup.cmd hashes against the independently authenticated manifest and SHA256SUMS-Windows before extraction. Extract only the verified ZIP into a disposable directory. Do not execute Setup.cmd or helper. The package helper root is <extracted>/Nexowire/app/dist (native/windows-job-owner.exe and native/windows-job-owner.sha256).

From the exact reviewed checkout with policy variables already set by the release owner, use the existing read-only verifier:

```powershell
$env:NX_VERIFY_JOB_ROOT = 'C:\ApprovedScratch\Nexowire\app\dist'
node --import tsx --input-type=module -e "import {assertTrustedWindowsJobPublisher} from './scripts/build-windows-user-bundle.ts'; const sha=assertTrustedWindowsJobPublisher(process.env.NX_VERIFY_JOB_ROOT,{...process.env,GITHUB_REF_TYPE:'tag'}); console.log(JSON.stringify({helperSha256:sha,verified:true,executed:false,activationAuthorized:false}));"
if ($LASTEXITCODE -ne 0) { throw 'Independent signed helper verification failed.' }
```

Independently inspect Windows Get-AuthenticodeSignature, exact subject, certificate DER SHA256, timestamp certificate, SignTool verify /pa /all /tw /v output and exit code, and actual extracted binary SHA256/sidecar. Record exact source/tag, archive/setup/manifest hashes, helper digest, signer DER hash and timestamp verification, tool/version, independent verifier identity and time; no private key, secret, token or live host state in receipts. Wrong signer, no timestamp, modified PE, stale sidecar, altered ZIP, missing trust policy or signature warning must deny. Real positive signer/timestamp verification remains NOT_RUN until approved signed bytes exist. A trusted SDK verifier and authenticated policy are prerequisites; this command does not provision trust roots, sign manifests or verify live process identity.

## AI-01 binding and reboot

#1368 installed identity review and NWJOB6 helper consistency remain read-only and return activationAuthorized:false/releaseAuthorized:false. Bind independent authenticated release manifest final signed helper hash, exact installed launcher digest, task definition/principal, runtime/import tree, held file/load identity and device/boot incarnation; never derive trust from adjacent checksum. Startup/cutover common serialized authority, current transaction and one-use forward grant must remain separate from static artifact acceptance. Reboot/crash invalidates forward grant; no persistent activation from signature or marker. Existing online cutover and AI-02 independent rollback denial stay unchanged. A signed helper is not a signed launcher, recovery authorization, or physical acceptance.

No live device, signing, publication, deploy, release tag or cutover action. Production NO-GO.
