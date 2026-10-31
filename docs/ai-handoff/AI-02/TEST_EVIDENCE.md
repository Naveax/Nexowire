# AI-02 | test evidence (exact SHA required)

## Verified baseline and earlier heads

- #984 parent `9d0f35607d4cde87bd031e2da77855cfaf570c31`: CI [41145160595](https://github.com/Naveax/Nexowire/actions/runs/41145160595) SUCCESS 8/8. **Parent evidence only**.
- AI-02 `a8e81f9188ce59e65c05c5349377df554e578be2`: CI [41196473837](https://github.com/Naveax/Nexowire/actions/runs/41196473837) automatically **CANCELLED** on newer commit; its Windows native suite had 3 PASS / 1 FAIL caused by nested Windows PowerShell 5.1 `Get-FileHash` module autoload, not security assertion weakening. Never label that run green.
- AI-02 `a847fa10047a738b175ffd71a981791c6cfffab8`: CI [41196792149](https://github.com/Naveax/Nexowire/actions/runs/41196792149) **SUCCESS 8/8**; fixed test runner uses `pwsh` for non-mutating disposable preflight. Windows .NET10 native job 4/4 PASS, 0 FAIL.
- AI-02 `e39cbfe29ac5cdb92a89b7b3abf5a253413c883a`: CI [41198403395](https://github.com/Naveax/Nexowire/actions/runs/41198403395) observed 7/8 SUCCESS and browser-live pending. Native Windows job 124529136098 SUCCESS; .NET10 build 0 warning/0 error, 4/4 PASS, 0 skip; opt-in 192-file package, `installed=false`. Full run verdict remains pending.

## New candidate tests requiring fresh exact-HEAD CI

- Native diagnostic self-test now covers local active-console policy negatives (mismatched session, remote protocol, disconnected and no active console), strict `status` vs `attest` framing, CNG signing, and **disposable** real-Windows kernel file-share exclusion / timeout cancellation / successful reopen. All are test-only fixtures and must not be called real owner approval.
- Installer read-only preflight uses a fake executable, temporary manifest and current SID; rejects mismatched owner, missing identity fields and cross-installation requests without installing.
- Opt-in uninstall no-service preflight is read-only. It does **not** test an actual SCM stop, deletion or restore.
- For new exact source HEAD: `node --test --import tsx test/core-persistent-enrollment-v2.test.ts`; `node --test --import tsx test/windows-local-enrollment-native.test.ts`; `npm run typecheck`; Windows `dotnet build native/windows-local-enrollment/Nexowire.LocalEnrollment.csproj -c Release -o native/windows-local-enrollment/bin/qa --nologo`; PowerShell `Parser.ParseFile` and opt-in build. Record CI run/status/exit codes after commit.

## NOT TESTED / barriers

- Actual locally installed SCM service/hostile IPC client, authentic signed owner ceremony, hardware TPM attestation, real clock/restart/rollback, two-device rollout, offline revocation and independently operated restore/revoke authority: **NOT TESTED**.
- Local assistant container lacks `dotnet`, PowerShell and repository dependency checkout. Never claim local success on the basis of remote/fixture tests.
- The new lock-file and console policy diagnostics exercise disposable OS features; they do not establish protected ProgramData ACL correctness or two-PC physical acceptance.
- The parent PR's CI artifacts and prior SHA PASS are not transferred to a new SHA. No duplicate dispatch/rerun on an active SHA/workflow/input.

## Native canonical text and revoked-marker hardening, source candidate

- Last verified HEAD: `0bdf0849d7815e3fad09875516f04521d22e025f`, CI run `41200786909` SUCCESS 8/8. This evidence does NOT transfer to later commits.
- New native `VerifyStrictNativeWireText` rejects trailing newline on account/SID/hash/LUID. JS regression checks the same exact values; .NET `\\z` is a strict end-of-input anchor.
- New `VerifyFailClosedRevocationEntries` uses isolated temp root to reject malformed file or directory-shaped `revoked.json` marker. Production Load does not use ambiguous `File.Exists` for revocation decision.
- Test command (Windows CI): `dotnet build native/windows-local-enrollment/Nexowire.LocalEnrollment.csproj -c Release -o native/windows-local-enrollment/bin/qa --nologo`; `node --test --import tsx test/windows-local-enrollment-native.test.ts`; `node --test --import tsx test/core-persistent-enrollment-v2.test.ts`.
- New exact SHA/run/exit codes require a later CI readback. Local container lacks .NET/PowerShell checkout and cannot claim local PASS. These tests do NOT prove physical Windows SCM/owner approval, TPM, restart or two-PC acceptance.

## AI-02 candidate: corrupt record + wrong service principal negative

- New exact-HEAD CI is required for the native `--self-test` malformed StoreConfig JSON matrix and separate non-SYSTEM uninstalled `--service` denial. No protected storage, physical device, service install, UAC or production ACL is used.
- Expected executable exit code: 1 for non-SYSTEM diagnostic `--service`, with `LOCAL_ENROLLMENT_REJECTED` and no side effects. CNG/SCM actual privileged start/stop/crash remains NOT TESTED.
- Last observed verified base `97cb3668fe7f37e95c9730912d6637fd0a963c56`, CI #41204589273 Windows native 4/4 PASS; overall CI status must be checked separately before claiming success.

## Consent issuer pin visibility (candidate, new exact SHA required)

- Existing baseline `622c82c49d4f22817f49051c9310306c01532911`: exact workflow CI #41205430526 completed **SUCCESS 8/8**, its Windows native job 5/5 PASS.
- New native disposable `--self-test` verifies canonical P-256 SPKI and displayed SHA-256 plus visible owner/device/installation scope; negatives cover padding/whitespace, malformed or truncated DER and P-384 curve. No MessageBox or real local consent is performed. A new exact HEAD CI must confirm native C# build and tests; no prior green-run inheritance.

## AI-02 final active-local-console gate / scoped revoke UI

- Last confirmed green exact HEAD `6a3c6f9f9f3a7421dd4de3b8846e819fdb45b66a`, workflow #41211679265 **SUCCESS 8/8**, Windows native 5/5 PASS (historical evidence, not transferable).
- New source candidate: repeat administrator, exact owner SID, and active console OS checks **after** contested revoke fence, and **after** TPM/software key creation before protected enrollment writes. Revoke dialog now displays exact owner/device/installation/enrollment/generation; its pure negative test rejects malformed grant, checks visible scope and real newline formatting.
- Physical SCM, local owner UAC/console, OS session switch, hardware TPM and crash/recovery are **NOT TESTED**. A real Windows test fixture and AI-08 independent source review remain required. Keep `mayDispatch=false`, CORE off, Draft and production NO-GO.

## Protected authority SPKI revalidation candidate

- After native source audit, `ProtectedStore.Load()` now proposes validation of
  the persisted authority SPKI on every read, not just at initial consent.
  Disposable native negatives reject wrong version, empty/malformed or padded
  authority key and a clean ephemeral positive SPKI. No real user keys, local
  enrollment, issuer approval, production SCM or UAC are touched.
- Candidate source requires its **own exact-HEAD CI**. Last previous source
  `e6fac5b2cf02903a08f3c75e6a021bb6376b241b` had CI #41243740113 queued/running at initial audit; no
  previous PASS is inherited. This shape validation does not bind a changed
  but valid public key to the historical physical consent. External issuer-pin
  provenance is a P0 dependency and CORE production NO-GO.

## Native IPC cryptographic self-consistency candidate

- Baseline exact HEAD `2fef25808393eb84232872507e2d316e9a23b327`, CI run #41243991732 **SUCCESS 8/8**, Windows native 5/5 PASS. Historical: the new commit requires a separate exact-run validation.
- `EnrollmentClient.RequireAcceptedFrame` now rejects a structurally valid fake `verified:true` response unless the supplied canonical P-256 key matches the grant's issuer hash and verifies the grant signature. For attestation, the signed witness must match the service-incarnation/SID/session/LUID and grant hash, and the runtime rejects stale witness TTL before stdout.
- Native `--self-test` uses ephemeral software P-256 fixtures and negative mutations for top-level and nested duplicate fields, unknown/missing fields, downgrade, `mayDispatch:true`, fake key/signatures, altered grant and mismatched witness.
- **NOT an independently pinned issuer or signed installed Agent identity.** Matching self-contained signatures are not grant authority. CORE disabled, Draft, physical-service and external mTLS/CAS NO-GO remain.

## Request-bound attestation candidate (new exact-SHA CI required)

- Extends AI-02 signed v2 IPC client to compare attestation witness against
  the **specific challenge request payload** passed by the caller, before
  accepting a valid signed frame. Null request context or foreign nonce,
  boot incarnation, OS session or logon LUID denies.
- Disposable self-test uses separate ephemeral EC keys for the device witness
  and the independently signed authority challenge. This proves only a
  local parser property, not a real external verifier or production consent.
- Await new exact HEAD CI. The preceding CI run #41246540822, whatever its
  eventual result, is historical evidence for preceding SHA `7f017aa2f97911e0b618866ec4b8f98cf9792237`.

## Installer explicit-opt-in regression candidate (new exact SHA CI required)

- Protect `install.ps1` from accidental mutable invocation: exactly one of
  `-PreflightOnly` and `-Execute`. Any invocation with complete matching
  fixture inputs but **without `-Execute`** must reject with
  `INSTALL_EXECUTE_OPT_IN_REQUIRED`, before Windows PowerShell 5.1/ACL/SCM
  mutation. Both switches reject `CONFLICTING_INSTALL_MODES`.
- Keep original `-PreflightOnly` positive + wrong owner/device/installation
  negatives unchanged; add these two fail-closed cases to the same disposable
  non-executable fixture. Tests never pass `-Execute`, so there is no service,
  CNG key, UAC, real owner approval or installed artifact.
- Pre-candidate source `4c2b379dd12c4b704d19e5804d83afae44dc10a7` has native 5/5 PASS and 7/8 overall jobs
  success in CI #41246829570 at last verified read; new HEAD requires new
  exact workflow result. No synthetic result or parent SHA transferred.

## Digest-pinned malicious manifest negatives (read-only candidate)

- The Windows preflight test now re-pins the **exact SHA-256 digest of each
  intentionally invalid fixture manifest**, so a wrong manifest digest cannot
  accidentally satisfy a semantic malformed-input negative.
- Five additional no-install negative cases: empty manifest files, parent
  traversal `../`, case-insensitive duplicate runtime entry, wrong pinned
  runtime SHA-256, and over-limit individual runtime entry length.
- Every invocation remains `-PreflightOnly`; the fixture executable is
  deliberately non-executable and no `-Execute`, UAC, CNG, SCM, owner consent
  or service writes occur. Both original owner/installation mismatch negatives
  and the no-`-Execute`/conflicting-mode negatives stay enforced.
- This candidate requires its **own exact-HEAD** Windows CI result; previous
  workflow #41248725949 may be superseded by the new SHA and must not be
  labeled full SUCCESS unless its final result explicitly says success.
