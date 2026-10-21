# #10: immutable Broker PID/FILETIME and external CORE CAS diagnostics

Date: 2026-10-21. This is **source-only, read-only QA**, stacked on #665. New files only in `src/diagnostics/` and `test/`; no #03/#04/#01 implementation edits.

## Independently checked source boundaries

- **#665** HEAD `54d5451d38aa3bb008640f9913bdabbd44980138`: GitHub CI `39644548125` **SUCCESS** verified. Earlier Work PC local expansion was blocked by ENOSPC, and hosted success does not prove physical High-token Broker deployment.
- **#700** HEAD `637ff3a6e8705e94e6ffba91790fd83329beee3f`: source models exact PID and decimal Win32 creation FILETIME, volume serial, open-file ID, image SHA-256 and full import/updater/ancestor ACL. CI `39645643225` **FAILURE**, Windows `browser-live` job red (other jobs success); production full-tree trust **NOT VERIFIED**. #700's own documentation identifies `importListIndependentlyEnumerated=false`, `signedImportManifestVerified=false`, `protectedCompleteImageTreeAttested=false` and incomplete low-privileged `PROCESS_DUP_HANDLE` evidence. A disposable PowerShell process identity is **not** a live Broker identity.
- **#702** HEAD `576eab8926c8257c13a47fa1be806554e2ecd190`: exact-head CI `39646460335` **SUCCESS**. Source adds a short-lived, atomic, signed dispatch claim and external CAS `beginIfCurrent/revokeAndDrain/release`; its remote authority and independent non-co-restorable service are **not deployed or physically attested**. Simulated CAS success is not durable external authorization.

## New diagnostic negative contract

`src/diagnostics/core-broker-filetime-cas-evidence.ts` is a **standalone source comparator** taking ONLY injected read-only observations. It independently checks (1) running Authenticode Broker image plus pinned publisher, exact PID, 64-bit *decimal string* FILETIME, volume serial/file ID/image SHA; (2) high/system token for **same PID and FILETIME**; (3) complete independently enumerated imports, signed manifest, launcher/ancestor/updater ACL, PROCESS_DUP_HANDLE boundary; (4) owner/device current signed CORE grant epoch/generation and revocation; (5) independent non-co-restorable external CAS witness epoch/generation; (6) fresh status request nonce and cache flags.

It **rejects or blocks** signed image UNAVAILABLE, wrong/reused PID FILETIME, missing updater/import trust, medium/unknown token, 401 or cached 401, visible `consent.exe`, requested CORE preference, stale/replayed owner epoch and unknown/outage external authority. Provider errors are sanitized; no bearer tokens, private paths or secrets returned. UNKNOWN never auto-replays.

**Fail-closed boundary:** even an entirely green injected provider is `provenance=untrusted_source_fixture`, `effectiveElevation=NOT_PROVEN`, `effectiveCore=false`, `authorized=false`, `dispatchAllowed=false`. This report must **not** be wired into privileged execution as a permit. Real signed Windows handle witness, verified owner epoch and external CAS belong to #03/#04/#01 and remain hard release gates.

## Provenance and safety

New 22 deterministic source negative tests and no 1 GiB artifacts. A standalone local Node 22 TypeScript-stripping prototype suite passed 22/22 and global TypeScript strict check passed before remote commit; **GitHub exact-head CI is independently required** for this branch. The previous Work PC disk reported ENOSPC, therefore no Work PC live test/rebuild and no removal of other workers' files. No live Broker/UAC/ACL/VM/service, no authenticated 43112 call, no high-token process launch.
