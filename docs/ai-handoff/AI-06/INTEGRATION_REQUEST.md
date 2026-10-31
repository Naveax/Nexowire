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
