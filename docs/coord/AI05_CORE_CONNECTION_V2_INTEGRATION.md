# AI-05 CORE + Connection v2 Windows integration, source-only NO-GO

Frozen main: `939b4d6beecf996f2750c736c5d4b4beb7b64488`
Frozen CORE #1067: `6241b05a798b8dc684ab8a9caf762896fbf1f3f0` (first parent)
Frozen Connection #1085: `44e7b3424c578515b70abdfe68b6a101cc0b2e5a` (second parent)
Windows Cloudflared #1077: `f49fbc070cd27a8c6b4c1d3f576484f95a3f14a8` (latest source probe and negative test only)

## Preservation contract
Build a two-parent Git commit from CORE tree plus exact Connection-only blobs.
Semantically combine only `.github/workflows/ci.yml` and `src/agent/native-agent.ts` from the same main baseline, retaining CORE native verified ACK, external CAS, WAL authority, real Windows Job/consent protections, and Connection v2 WSS, strict owner-device authorization, reconnect UNKNOWN/no-replay.
Keep S5 57/57 acceptance, Windows security oracles, CLEAN-10 and real PostgreSQL jobs in CI. Do not skip tests.
Refresh exact `native/windows-cloudflared-image-probe.c` and `test/clean13-cloudflared-windows-image-probe.test.ts` from #1077 for whole-chain signer revocation and unsigned-matching-SHA negative. This still does not prove kernel executable-image provenance.
Legacy Connection source matrix has 79 original source rows with only candidate SHA/status reconciled. Full combined per-source matrix: `docs/coord/AI05_CORE_CONNECTION_V2_PRESERVATION.csv`.

## Migration ordering
Current main: 0018, 0019. CORE adds 0020 native logon binding and 0021 native claim verified. Connection #1085 adds no migration. New AI-03 authorization epoch/lease migration must allocate a separate higher version. No deployment or migration applied.

## Verification and AI-06 handoff
Earlier #1067 CI run 42102010726: 7/7 PASS on older SHA; current CORE CI run 42107444003 active at freeze. #1085 predecessor SHA `25227d0d` CI 42087533258: 16/16 PASS. Neither is combined acceptance.
Required on exact new integration SHA: Windows Node 22/24 browser-live, kernel Job and Native ACK, external CAS, S5, security negative P1-A/B/D, CLEAN-10 duplicate UUID/stale ACK/UNKNOWN, owner/device revoke, WSS fail closed. Independent source-owner semantic review and AI-06 must complete.
NO-GO: executed Windows Cloudflared image provenance; owner/device atomic revocation at native effect admission; independently hosted rollback-proof CAS; authoritative Control Plane epoch/lease; physical two-PC/off-network/reboot/soak acceptance NOT_RUN. No main merge, production CORE, credentials, billing, physical device or public ingress changes.
