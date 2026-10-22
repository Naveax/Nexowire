# Worker #30 | #754 final publication receipt vs #718 quota UNKNOWN/writer-stop

**2026-10-22. QA-only isolated child of DRAFT #754, production NO-GO.**

## Baselines independently checked

- #735 parser QA exact HEAD `d4c35e2a7adec3b845b03886f314772a65473d63`, workflow `39735083325` **SUCCESS**. Parser fairness is covered; **no additional parser tests**.
- #738 4×9.5MiB decoded gzip parser exact HEAD `ce85d257c2f005156175a4d14a65ec81565575fc`, workflow `39677587592` **SUCCESS**. This branch performs **zero** compressed-load tests.
- #754 final publication owner exact HEAD `3a5bf392109d17dbf2650a18398917d5501fd488`, workflow `39736052869` overall **FAILURE**, specifically inherited `browser-live` **Physical Windows Job Object regressions**. Node22/24 and five other CI jobs succeed. A signed final destination publication is **not** writer stop or staging cleanup.
- #718 quota owner exact HEAD `539c6be5eadd05635a16ff7e0aa306e36314bc4c`: querying exact-head GitHub Actions returned **no runs**. Existing comprehensive source negatives include UNKNOWN/late ACK, two Hub re-pair, external monotonic CAS, immutable deletion witness, active writer and idempotent one-time storage release. They are **not duplicated** or replaced.
- #754 does **not** contain the separate #718 `src/ops/scale-v2-artifact-fenced-cleanup-admission.ts` branch. This test imports #754's **actual `CrossDeviceTransferJobs` source** plus its existing in-memory staging `StagingArtifactByteBudget` and makes a deliberately explicit **test-only** memory/write-stop model. This is **not** an actual runtime integration of #754 with #718.

## Only distinct negative boundary

`test/worker30-final-publication-quota-stop-seam.test.ts` uses deterministic local synthetic Native writers, an ephemeral temporary directory for the actual #754 job journal, and a separate **in-memory SQLite staging quota**. Two cases:

1. A synthetic native publisher writes the target and **loses the final ACK**. The actual durable #754 journal remains `MUTATION_UNKNOWN`, preserves `TRANSFER_PUBLISH_OUTCOME_UNKNOWN`, exact `publication.requestId`, epoch and SHA, and executes Native publication exactly **once**.
2. A different synthetic publisher delivers a cryptographically verifiable **final destination publication receipt**; #754 legitimately marks publication `COMPLETED`. However, that receipt is **not** a writer-stop or stage-deletion attestation. The separate TEST-ONLY memory escrow refuses to release even if the client asserts `writerStopped:true`; a different privately issued proof of a final publication is not a writer-stop proof.
3. In both modes, **a simulated older writer-stop proof minted before re-pair** becomes stale after ownerEpoch advances; 128KiB owner-A memory remains held. Owner B can separately reserve up to its own 128KiB test limit. The real source staging SQLite retains **2 pending 64KiB chunks** and **262,144 B of reserved file capacity**. Neither signed final publication nor a lost ACK can cause a phantom staging release or byte refund.
4. There is **no actual independent signed writer-stop service**, no real OS readback/physical deletion, and no Cloudflare CAS or live Native. The issuer and all Native operations are intentionally **synthetic**. Do not mistake an HMAC in the QA transfer fixture for a hardware-backed or external production signature.

## Exact-SHA test and evidence boundary

```sh
node --test --import tsx test/worker30-final-publication-quota-stop-seam.test.ts
npm run typecheck
```

The test log marker `QA30_FINAL_QUOTA_UNKNOWN` reports job state, original error code, exact Native publication requestId/SHA, PENDING/reserved counts, owner memory totals, and **`physicalSignedWriterStop:false`**.

All production native privileges, cross-Hub real external monotonic CAS, full disk readback, signed installed Broker, authenticated 101+ public WSS, physical 1GiB file end-to-end, paid Cloudflare and VM scenarios remain **BLOCKED / NO-GO**.

Only the **QA test and this documentation** are added. No change to production MCP, quota implementation, #08 owner final receipt, existing tests, Windows Job test, workflow, Agent, Hyper-V or ReVoltVPN-Ubuntu-Lab. Read the new exact PR-branch SHA and separate GitHub Actions outcome, preserving any inherited Windows red.
