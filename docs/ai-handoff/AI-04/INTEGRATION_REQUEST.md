# AI-04 INTEGRATION REQUEST | coordinator / AI-05 / AI-07 / AI-08

1. **AI-05**: every *separate* real Windows effect must obtain independent Broker-side per-effect `operationId` admission on the exact frozen input SHA-256, device/owner/session epochs, durable reserve and one-time commit. Lost ACK/UNKNOWN must be terminal and never re-execute. AI-04 does not edit `src/agent/executors.ts`.
2. **Independent CAS owner / coordinator**: supply pinned, OS-protected verifier for `verifyReceipt(receipt,signedPayloadUtf8)`; prove durable tombstone, generation/revoke and one-use commit across restarts. Fake receipts and a JS boolean are not acceptable.
3. **Signed-wire producer contract**: dispatch receipt bytes must be exact compact `JSON.stringify` UTF-8. JS roundtrip equality is required by both fence and handler. Non-JS producers need test vectors for field order, character escapes, number formats, duplicate keys, UTF-8 validity and Ed25519 signature bytes before integration. Do not loosen negatives to admit pretty JSON.
4. **AI-07 + coordinator**: real isolated lower-privilege worker, per-principal service SID/ACL and protected IPC/handle boundary are needed to resolve initial guardian Job pre-seal duplicate-handle window, equal-HIGH/SeDebug and UAC-linked Medium attack paths. Current Job kernel membership/limits or provisional DACL is insufficient physical evidence.
5. **AI-08**: independently review Draft #987 source + 26 AI-04 incremental tests; replay/ABA/accessor, canonical signed wire, Job inherited handle, warning C4133 and Windows negative SKIP/BLOCKED truth. Diff compare exact parent/base and verify active CI exact SHA; mocks must not be promoted to PASS.
6. **Coordinator only**: own any shared `.github/workflows/**`, installer/manifest/trusted helper signing and inter-agent integrations. No AI-04 change to those files. Authoritative 7/7 CI and two-device physical enrollment remain distinct gates.

**CORE execution/release: NO_GO until authentic external CAS and independent OS principal/token + Job handle/descendant proof are installed and independently accepted.** No merge/deploy/live device activity authorized.

## Harici owner/session kimlik otoritesi gerekliliği
- AI-04 Broker source çağrısı, reserve ve commit `await` sınırlarından sonra imzalı request kapsamını `verifyIdentity` ile yeniden doğrular. Bu sözleşmenin gerçek sağlayıcısı AI-03/AI-05/koordinatör tarafından pinli, protected device/session/owner readback olmalıdır. Basit mutable boolean veya UI grant fiziksel kanıt değildir.
- Otoritenin revoke/effect admission işlemi yine **atomik** olmalı: iki ayrı asenkron source check'i efektle aynı linearization point garantisini vermez. Kaybolan ACK/durable tombstone NO-GO sınırlarını gevşetmeyin.
