# AI-06 | Koordinatör, AI-02 ve AI-03 entegrasyon talepleri

**Yalnız talep:** AI-06 başka ajanın kaynaklarını değiştirmedi.

## AI-02: Windows enrollment / Broker sınırı

- Korunmuş native enrollment servisi gerçek Windows kullanıcı onayını, cihaz sahibine bağlanan SID + logon LUID + session ID + session epoch ile imzalı ve geri alınabilir biçimde sağlasın.
- Credential/anahtar koruması, signer origin, atomik bir-kerelik tüketim ve rollback-independent ledger ayrı native/OS trust boundary tarafından doğrulansın. JS fixture veya D1 payload fiziksel onay sayılmasın.
- Broker çevrimdışı, privilege mode değişimi, UAC / Secure Desktop, kilitli ekran, kullanıcı çıkışı ve session değişiminde yürütme öncesi deny/UNKNOWN dönsün.
- Bir claim'in native son kontrol ile ilk efekt arasındaki TOCTOU penceresi için effect-boundary atomik `verifyAndConsumeBeforeEffect` veya eşdeğer kernel readback/CAS sözleşmesi sağlansın.

## AI-03: Native consent transport / actuator

- D1 claim ACK'si, Agent `inspect()` ve final native effect, **aynı immutable requestId + fingerprint + owner/device/session/target** kapsamını taşısın. Async sınırda nesne mutasyonu yeniden onay üretmesin.
- Native actor gerçek input/OS etkisinden hemen önce güncel desktop, foreground/target process creation, owner SID, AuthenticationId, session epoch ve revoke/STOP neslini kontrol etsin. Atomiklik kanıtlanmıyorsa callback kapalı kalsın.
- Revoke, logout, fast user switching, lock/unlock ve uncertain lost-ACK durumları için dış ledger tombstone/STOP ve nonreplay kanıtı paylaşsın.
- Korumalı native servis olmadan test-local verifier, sentetik receipt ve read-only Win32 session witness `ALLOW` üretmemeli.

## Koordinasyon ve dallar

- AI-06 tabanı: #980 HEAD `7e4093c30c1ead3cd22888184450c34aef4737da`; #951 ve #961 bu tabanın atası olarak GitHub compare ile doğrulandı.
- #984 local enrollment ve #982 mTLS verifier ayrı Draft dallarıdır; AI-06 bunları **otomatik birleştirmedi**. Bağımlılık ve API bağlama, koordinatörde.
- Koordinatör sahipliğindeki `src/agent/native-agent.ts`, `src/agent/operation-journal.ts`, `package*.json`, `.github/workflows/**` ve deploy dosyalarında değişiklik yapılmadı.

## Gerçek kabul için gerekli kanıt

İki Windows PC üzerinde owner-bound yetkili fiziksel approval, logoff/switch/lock/unlock/restart, native callback gerçek hedef doğrulaması, imzalı servis ve credential trust, uzak revoke ve claim ACK kaybında reboot sonrası tek-kullanım davranışı ayrı kaydedilmeli. Equal-HIGH veya read-only witness başarılı native yetki sayılmamalı. Bunlar olmadan **CORE NO-GO**.

## AI-06 P0: D1 claim readback sırasında erken complete yarış riski

`src/product/d1-core-console-authority.ts` şu anda `claim` işleminde
`reserved -> dispatched` değişikliğini native `currentReadback()`
tamamlanmadan **önce** yapıyor. Aynı credential + imzalama anahtarına erişen,
eşzamanlı ikinci istemci `complete(succeeded)` çağrısını claim verifier
henüz beklerken yollayabilir. `complete` SQL'i `state='dispatched'`
görüp başarıya çevirebilir; native verifier daha sonra DENY dönerse claim
catch yalnız `state='dispatched'` satırını tombstone yapar ve
`succeeded` kaydını silemez. Bu senaryo henüz izole canlı testle
doğrulanmadı, fakat mevcut SQL karşılaştırmaları bunu engellemiyor.

**Koordinatör migration/AI-03 ledger talebi:** Operation şemasına terminal
olmayan, `complete` tarafından kabul edilmeyen `claiming` durumu veya
eşdeğer **persisted native-readback-approved CAS marker** eklenmeli.
Readback sonrasında yalnız kazanan claim atomik `claiming -> dispatched`
geçişini yapsın; hata/UNKNOWN terminal tombstone kalsın. `complete`
yalnız readback onaylı state/marker üzerinden yürüsün. SQL CHECK durum
kümesi `cloudflare/migrations/0019_core_console_authority.sql` içinde,
bu migration koordinatör sahipliğindedir; AI-06 onu değiştirmedi.
Mevcut duplicate-claim winner negatif testlerini gevşeterek veya belirsiz
işlemleri yeniden kullanarak bu sorun kapatılamaz. Çözüm gelene kadar
production CORE **NO-GO**.

## Ek AI-06 fail-closed kaynak düzeltmesinin sınırlılığı

`tombstoneDispatched` artık native claim DENY/UNKNOWN sırasında
`dispatched/succeeded/denied -> unknown` audit fence uygular (yalnız
`reserved->dispatched` CAS kazananında). Böylece eşzamanlı erken
`complete(succeeded)` kalıcı yanlış başarı kaydı bırakmaz. Fakat
premature `complete` **kabulü** hâlâ mümkündür; AI-08
`acceptedEarly=false` regresyonu hâlâ kırmızı olmalıdır.
Migration/ledger eksikliğini örtmek için bu iyileştirme kabul kanıtı
olarak kullanılmamalıdır.

## Coordinator native-claim-verified SQL dependency handoff

AI-06 added the post-readback `native_claim_verified=1` compare-and-swap to owned `src/product/d1-core-console-authority.ts`, guarded by the full immutable original scope, live D1 READY and native SID/session/LUID/epoch binding. Completion now requires marker 1 for `succeeded` and `denied`; UNKNOWN can safely tombstone an uncertain dispatched ID. The in-memory test-local migration shim is *not* the coordinator's production migration.

**Coordinator action:** Integrate the separate Draft #996 `cloudflare/migrations/0021_core_console_native_claim_verified.sql` with this source into a reviewed integration build; perform native verifier/OS effect-boundary checks; re-run the **independent, unrelaxed AI-08 early-complete regression** and full isolated suites. Do not enable CORE until real owner-bound Windows effect evidence exists. AI-06 did not merge, edit or deploy #996.
