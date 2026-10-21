# Nexowire #08, 21 October 2026: Native cancellation and error provenance

## Exact source and QA provenance

- Parent PR #691 exact HEAD `437030d288fdf13441f506ce83a9ff72644822dd`, GitHub run `39644905819` SUCCESS, descends from PR #667 `8cbf5c06dfe7677e38f896f90a8dac63eae04458`.
- Independent #640 original QA blob `c4ed63569d94a1abfa72b434a3a3b05eecf07055`; #651 original blob `d827f9ad5d12840bd0e9c2c3f6300c9870a9a4bb`; #677 extra reopened-journal blob `a763d20c08a5eb07fa02aaf5c6b35e110956194e`; #682 QA #22 blob `28048c55ad575ec78d1e9d4b9c6ce9fe47f316a3`. All four verified byte-identical to their GitHub PR branch sources and executed unedited.
- #677 Node22 run `39644025130` FAILURE: first verified chunk cancelled before second read, but source read #2 still sent; Native forged-requestId receipt after dispatched write lost `FORGED_WRITE_RECEIPT` errorCode due to cancellation generic overwrite. #682 Node24 run `39644551666` FAILURE: late cancel on its older base turned potentially published/ACK-lost UNKNOWN into false CANCELLED; additionally three typed CORE/lease publish denials were generalized. Its older E2E uses a previously fixed 120ms timing sleep.
- Replayed #640/#651/#677/#682 independent QA on exact #691: **20/25 PASS, 5/25 FAIL**. The five failures were unauthorized second read (1), overwritten forged receipt provenance (1) and publish CORE owner revoke / lease expiry / re-pair codes (3). On corrected source: **25/25 PASS** without modifying any of these QA files. #691 already includes the late UNKNOWN-cancel fix; original #682 late-cancel case also passes after integration.

## Narrow owner-file production source fix

Only `src/mcp/cross-device-transfer-jobs.ts` source logic is changed:

1. Re-check durable cancellation after async external CORE/epoch checks **before starting any next source read**. This stops the second chunk read after the first independently verified 64 KiB staged write has been cancelled. Previously this gap could read source after cancellation before the next journal check.
2. If a forged Native ACK is observed after the underlying write might have occurred, preserve `MUTATION_UNKNOWN`, the original `pending` requestId/epoch/offset/sha and the specific `FORGED_WRITE_RECEIPT` error even if another Hub's cancel was pending. A generic cancellation marker must not overwrite a stronger observed authenticated failure. A later cancel cannot downgrade to `CANCELLED` or automatically replay the native write.
3. Keep pre-publication CORE grant and external epoch checks under the same fail-closed publish exception boundary. Rejecting grant, expired epoch or stale owner pairing preserves `MUTATION_UNKNOWN` **and** the specific typed `CORE_OWNER_REVOKED`, `NATIVE_LEASE_EXPIRED` or `CORE_GRANT_EPOCH_STALE` reason. Ordinary unknown Native publish ACK remains `TRANSFER_PUBLISH_OUTCOME_UNKNOWN`; this does not fabricate physical publication success.

## New owner regression and independent run

`test/artifact-08-owner-receipt-cancel.test.ts` adds three deterministic in-memory synthetic tests: forged ACK during cancellation and reopened Hub re-cancel preserve error/pending/no replay, typed Native publish rejection remains UNKNOWN through late cancellation, and cancel during external pre-second-read gate issues no second read. There are no wall-clock race sleeps.

- Independent QA files: **25/25 PASS** (unchanged).
- Owner regression: **3/3 PASS**.
- Focused Artifact Bridge, two WebSocket sandbox Agents, offset, CORE grants, journal, quota and checkpoint suite: **147/147 PASS** including the independent tests. `npm run typecheck`, `npm run build`, `npm run continuation:check`, and diff checks PASS.
- Only ~221 KiB or smaller generated buffers / isolated stores are used in this P0 followup. No live device file transfer or 1 GiB physical fixture.
- #640/#651/#677/#682 QA files were temporarily copied into a separate source-only worktree and removed before owner commit. Tests remain owned and reviewed independently by #21/#22.

## NO-GO boundaries

The real independent rollback-external monotonic CAS witness (#587), signed and trusted Native atomic epoch/offset writer (#05), authenticated quota receipts (#610), connection owner grant/journal reconciliation (#613), physical staging/soak QA (#16), and integrator #00 remain unmet. Native Agent 1.0.5 does not provide production fenced CAS or >256MiB physical acceptance. Source QA does not imply production acceptance. No live Hub/Agent/VM restart, production deploy, main merge, user file overwrite or deletion.
