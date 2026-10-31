# AI-08 | Negatif test kanıtı (exact SHA/CI ayrımı)

## CI kanıt seviyeleri

### Doğrudan ölçülmüş AI-08 kaynak testleri
- **Kaynak HEAD:** `44f18a925974c9eb9743d366ded1d81ca851b95a`
- **Workflow:** CI, run ID `41194807179`, GitHub Actions `pull_request` (Draft #989).
- **Node 22:** `npm run typecheck`, `npm test`, `npm run build` **SUCCESS (exit 0)**; test suite `2787 total / 2431 PASS / 0 FAIL / 354 skipped / 2 TODO`; ilk **17 AI-08 testi PASS**.
- **Node 24:** `npm run typecheck`, `npm test`, `npm run build` **SUCCESS (exit 0)**; aynı 2787/2431/0/354/2, **17 AI-08 PASS**.
- **CI Node job IDs:** Node22 `124518726574`; Node24 `124518726530`.
- **WAL gerçek fixture geometrisi:** SQLite tarafından üretilen `2 current-generation / 161 prior allocation frames`. Önceki gerçek kullanıcı vakasının 709/295 sayısını fiziksel olarak tekrar ettiğimiz iddia edilmez.
- **Diğer CI job'lar:** Linux native, local enrollment native, WSL2, macOS, security-operational işleri önceki HEAD için SUCCESS görüldü. `browser-live` tam işin final sonucunu doğrulamadan tüm-run SUCCESS denmez.

### Daha sonra eklenen D1 claim/admission negatifleri
- **Kod commit:** `913230d378d9331eab01d7bb36094123d4fbe107`.
- **Test dosyası:** `test/ai08-console-claim.test.ts`. Offline, admin-bridge not-ready, privilege downgrade, platform switch, CORE disabled senaryoları. Her birinde async native readback sırasında D1 güncellenir; claim yanlışlıkla sürdürülmemeli; tüketilmiş request ID unknown/terminal kalmalı.
- **Bu ek testlerin ölçüm durumu:** `NOT_TESTED` bu doküman yazılırken. Commit `913230d...` için yeni run ID `41195396312` pending gözlendi. Nihai docs HEAD'in gerçek run'ı ayrıca doğrulanacaktır.

## Referans PR exact-SHA kanıtları (AI-08 testleri yerine kullanılamaz)

| Alan | PR / durum | exact HEAD | CI run | Sonuç |
|---|---|---|---|---|
| v1.0.8 main WAL candidate | main | `a19a228dc6f19fd484cf935e941a00ea625233f8` | `41078541065` | SUCCESS; physical CORE değil |
| External CAS nested request | #946 Draft | `00330e83e6fd4cf59d86bbbda3fb7c213f258ee4` | `40674859833` | **FAILURE: 3 adversarial** |
| Immutable CAS source fix | #947 Draft | `49109b082f811174894bf268ae1e57dbb2bea50d` | `40698276841` | SUCCESS |
| Broker signed receipts | #950 Draft | `4c92f676c5d0ce0dd6c85a6288912ab21bf4a80c` | `40752196776` | SUCCESS |
| Windows mutation dispatcher | #916 Draft | `0b505e053cb99704015700faf47c9c437862abef` | `40705681126` | SUCCESS |
| Console D1 race adversarial | #949 Draft | `2829db965bee48312e4614cd234caf34e7de24d4` | `40705928887` | **FAILURE: 6 adversarial** |
| Console D1 race source fix | #951 Draft | `169186b90a51619d79ff29a93a1770f4a9d4bdf2` | `40712106650` | SUCCESS |
| #07 OS sandbox provider | #859 Draft | `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9` | `40547392793` | SUCCESS; deny-only stub |
| mTLS source client | #982 Draft | `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39` | `41139860087` | SUCCESS; source/loopback |
| Integration candidate | #980 Draft | `7e4093c30c1ead3cd22888184450c34aef4737da` | `41113730982`, `41113730994` | SUCCESS; NO_GO |
| QA source base | #984 Draft | `9d0f35607d4cde87bd031e2da77855cfaf570c31` | `41145160595` | SUCCESS; AI-08 testlerini içermez |

## AI-08 negatif matris

| Negatif senaryo | QA dosyası | Ölçüm sınıfı | Kanıt (44f18...) |
|---|---|---|---|
| WAL RESTART/recycle, UNKNOWN korunur | ai08-wal-recycle | DISPOSABLE_SQLITE | PASS |
| Current WAL checksum damage, index header mismatch | ai08-wal-recycle | DISPOSABLE_SQLITE | PASS |
| Revoked owner, SID, machine, boot/session freshness | ai08-enrollment-sandbox | SYNTHETIC_UNIT | PASS |
| Server SPKI mismatch, immutable origin/redirect refusal | ai08-mtls-pin | LOCAL_TLS_LOOPBACK | PASS |
| Signed receipt scope/capability mismatch, COMMIT ACK loss | ai08-broker-receipt | SYNTHETIC_UNIT | PASS |
| CAS deep request identity mutation, signed scope substitution | ai08-cas-scope | SYNTHETIC_UNIT | PASS |
| D1 claim readiness loss during async native readback | ai08-console-claim | SYNTHETIC_SQLITE | NOT_TESTED on 44f18...; test later committed |
| Fake native sandbox attestation, hostile getters, UNKNOWN replay | ai08-enrollment-sandbox | SYNTHETIC_UNIT | PASS |
| Actual handle/env inheritance, descendant breakout, network/IPC, revoke drain | #07 native OS handoff | ISOLATED_NATIVE_OS | BLOCKED |
| Two physical PCs: true owner UAC/DPAPI/CORE 24h, reboot/sleep | owner-controlled staging | PHYSICAL_TWO_PC | BLOCKED |

## Yeniden çalıştırma
```bash
node --test --import tsx test/ai08-*.test.ts
npm run typecheck
npm run build
```
**Doğrudan elde edilmiş Node test exit code:** 0 (17 testli `44f18...` HEAD). Yeni D1 test ve nihai PR HEAD sonuçlarını ayrı exact SHA/run ile doğrula. Shell wildcard expansion platformu farklıysa `npm test` CI doğrulanmış alternatifidir.

**NO_GO:** `SYNTHETIC_UNIT`, disposable SQLite, localhost TLS, hosted Windows runner sonucu gerçek Windows owner-consent/TPM/mTLS production, native sandbox kernel isolation veya 2-PC physical acceptance değildir. #974 WAL P0, #539 reliability açık kalır.


## 31 Ekim 2026 · exact-SHA AI-08 güncellemesi (önceki pending notlarını geçersiz kılar)

- **Test kodu HEAD:** `9feb149e1b2723bb4609d21e4167824e400e9b85` (parent `21ea657db668ed90157ea42605b7c8de87563c8b`). Draft PR [#989](https://github.com/Naveax/Nexowire/pull/989), base #984 `9d0f35607d4cde87bd031e2da77855cfaf570c31`.
- **Exact CI:** [#41196966679](https://github.com/Naveax/Nexowire/actions/runs/41196966679). Node 22 job `124525116348`: **SUCCESS**, independent AI-08 32/32 PASS; Node 24 job `124525116481`: **SUCCESS**, independent AI-08 32/32 PASS. İkisinde de `npm run typecheck`, `npm test`, `npm run build` exit 0.
- **İki Node suite:** her biri 2.802 test, 2.446 PASS, **0 FAIL**, 354 SKIP, 2 TODO. Bu 354 SKIP eski suite toplamıdır, yeni 32 AI-08 testi skip edilmedi.
- **On adet yeni negatif:** D1 claim'in async native readback penceresinde owner epoch, grant generation, revoke epoch, enrollment ID, native receipt ID, Windows SID, session ID, logon LUID, Windows session epoch ve SAFE erişim moduna geçiş. Her senaryoda claim `CORE_NATIVE_CONSENT_SESSION_CHANGED` ile reddedilir, tüketilmiş request ID `unknown` terminal kalır ve tekrarlı claim doğrulayıcıyı ikinci kez çalıştırmaz. Kod: `test/ai08-console-claim.test.ts`.
- **Windows browser-live:** son tam sorguda workflow hâlâ `in_progress` idi; bağımsız Windows işinin final sonucu doğrulanana kadar workflow geneli SUCCESS sayılmaz. Bu dokümanları güncelleyen yeni commit için CI ayrıca **yeni exact HEAD** üzerinde ölçülmelidir.
- **Kanıt sınıfı:** D1 testleri SYNTHETIC_SQLITE (gerçek ürünün source-level D1 API'si, sentetik native readback), WAL DISPOSABLE_SQLITE, mTLS LOCAL_TLS_LOOPBACK, diğerleri SYNTHETIC_UNIT. **Gerçek OS sandbox isolation / native owner UAC / kalıcı fiziksel enrollment / iki-PC 24h kabulü BLOCKED; CORE production NO_GO.**
- **CI tekrar politikası:** mevcut active `(workflow, SHA, inputs)` run'ını yeniden dispatch etme; her rapor aynı exact SHA/run'a bağlanır. Eski iptal edilmiş run'lar FAILURE diye yeniden sınıflandırılmaz.
