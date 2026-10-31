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

## AI-04 handler provider-owned witness ve credential yenilemesi (kaynak düzeyi)

- Handler, `authenticateBroker` principal ve `readProtectedBroker` nesnelerindeki yalnız kendi **data descriptor** alanlarını, prototype ve fazladan alan kontrolüyle snapshot'lar. Accessor, inherited, proxy trap, eksik veya fazladan alanlar fail-closed reddedilir. Bu değişiklik **fiziksel Windows kernel attestation değildir**.
- Yeni begin/commit admission için protected Broker readback sonrasında tekrar `authenticateBroker` yapılır ve immutable owner/device/session principal karşılaştırılır. Release, ilk authenticated Broker principal + exact reservation CAS kontrolüyle; revoke ise buna ek olarak doğrulanmış imzalı owner onayıyla yürür. İptal/temizlik yeni grant kabulü değildir.
- Mevcut `test/broker-dispatch-authority-handler.test.ts` içerisine readback accessor/inherited/proxy, authenticated principal accessor/inherited ve readback sırasında credential revoke negatifleri eklendi. CI bu yeni HEAD üzerinde doğrulanmadan PASS kabul edilmemelidir.
- **Koordinatör:** `authenticateBroker` eski boolean/cache yerine canlı/korumalı principal kaynağını okumalı; aynı request için tekrar doğrulanma desteği sağlamalı. Final effect admission için owner+OS atomik linearization yine ayrı P0 ve CORE NO-GO.

## Düzeltme: eski claim'in release işlemi yeniden owner/grant kabulü değildir

- `release` isteğinin başındaki authenticated Broker principal, exact `dispatchId`, `brokerId`, `request`/scope doğrulaması ve uzak authority'nin **durable immutable reservation** eşleştirmesi korunur. Release sırasında yeniden canlı credential sorgulamak iptal edilmiş grant'i temizleyememe riski taşır, bu yüzden ikinci kontrol yalnızca yeni begin/commit admission işlemlerinde kullanılır.
- Regresyon: İlk TLS/Bearer principal kabul edildikten hemen sonra credential iptal edilirse önceden rezerve edilmiş claim release edilir; aynı revoked credential yeni `begin` açamaz. Test sadece sentetik HTTP+CAS kanıtıdır.
- **Açık entegrasyon ihtiyacı:** İlk authenticate anından önce credential zaten iptal edildiyse cleanup'a izin verecek ayrılmış protected release/reconciliation principal veya owner-onaylı drain API koordine edilmelidir. Sahte trusted fallback koyulmadı; CORE NO-GO devam eder.

## Owner-signed revoke/drain için canlı credential TOCTOU

- Aynı prensip `revoke-and-drain` için de geçerlidir: ilk TLS/Bearer Broker principal ve immutable owner/device/session kapsamı ile `verifyOwnerRevocation` gerçek owner imzası zorunlu kalır; ancak istek gövdesinden sonra ikinci **canlı grant** kabulü yapılmaz. Arada credential expire/revoke olursa signed owner iptali fail-open bir mutasyon değildir.
- Mevcut owner signature negatif testi korunur; pozitif revoke aşamasında ilk authenticate'den hemen sonra credential invalid olmasını taklit eden regresyon eklendi. Signed owner kanıtı yoksa revocation CAS çağrısı yine reddedilir.
- İlk authenticate öncesi iptal edilmiş credential veya revocation sırasında ayrı güvenli yetkili kanal gereksinimi koordinatör kapsamındadır. Doğrulanmış OS SID, dağıtım veya uzun ömürlü token uydurulmadı; CORE production NO-GO.
