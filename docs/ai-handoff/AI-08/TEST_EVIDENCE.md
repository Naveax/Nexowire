# AI-08 | Exact-SHA test kanıtı ve negatif matris

**Gözlem:** 2026-10-31. **Bu dosyaya yazılırken AI-08 yeni testleri henüz GitHub CI'da çalıştırılmadı.** PASS iddiası yerine `NOT_TESTED` kullanılır. İlgili PR run'ları bağımsız AI-08 test sonucu değildir. Yerel çalışma ortamında GitHub DNS ve npm checkout erişimi yoktur; CI sonrası gerçek exit code ve job sayıları haricen doğrulanmalıdır.

## Referans kaynak/CI kanıtı

| Alan | PR | exact HEAD | CI run | Gözlenen sonuç |
|---|---|---|---|---|
| main 1.0.8 / WAL birleşik | #957 (closed), main | `a19a228dc6f19fd484cf935e941a00ea625233f8` | `41078541065` | SUCCESS; yayın ve canary ayrı issue #974 |
| #01 CAS immutable request | #947 Draft | `49109b082f811174894bf268ae1e57dbb2bea50d` | `40698276841` | SUCCESS |
| #02 Broker signed receipt | #950 Draft | `4c92f676c5d0ce0dd6c85a6288912ab21bf4a80c` | `40752196776` | SUCCESS |
| #03 guarded Windows mutation | #916 Draft | `0b505e053cb99704015700faf47c9c437862abef` | `40705681126` | SUCCESS |
| #04 claim readiness adversarial | #949 Draft | `2829db965bee48312e4614cd234caf34e7de24d4` | `40705928887` | FAILURE |
| #04 claim readiness source fix | #951 Draft | `169186b90a51619d79ff29a93a1770f4a9d4bdf2` | `40712106650` | SUCCESS; fiziksel PASS değil |
| #07 sandbox provider | #859 Draft | `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9` | `40547392793` | SUCCESS; source only |
| mTLS client | #982 Draft | `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39` | `41139860087` | SUCCESS; loopback/source only |
| integrated candidate | #980 Draft | `7e4093c30c1ead3cd22888184450c34aef4737da` | CI `41113730982`, Release Readiness `41113730994` | SUCCESS; CORE NO_GO |
| independent QA target base | #984 Draft | `9d0f35607d4cde87bd031e2da77855cfaf570c31` | `41145160595` | SUCCESS; AI-08 testleri henüz bu HEAD'de yok |

#946 adversarial nested scope, exact HEAD `00330e83e6fd4cf59d86bbbda3fb7c213f258ee4`, CI `40674859833` **FAILURE**. #974 açık P0'dır; 1.0.8 canary / yayın kanıtı tüm cihaz kabulü değildir.

## Negatif kanıt matrisi

| Modül ve negatif senaryo | Yeni AI-08 test | Sınıf | Durum |
|---|---|---|---|
| WAL valid RESTART/recycle retained old tail + UNKNOWN | `ai08-wal-recycle` | DISPOSABLE_SQLITE | NOT_TESTED |
| WAL bad current frame / tampered SHM second header | `ai08-wal-recycle` | DISPOSABLE_SQLITE | NOT_TESTED |
| Enrollment revoked owner, SID, machine and session mismatch | `ai08-enrollment-sandbox` | SYNTHETIC_UNIT | NOT_TESTED |
| mTLS wrong SPKI pin never reaches handler; immutable origin | `ai08-mtls-pin` | LOCAL_TLS_LOOPBACK | NOT_TESTED |
| Broker receipt mismatched scope/signature/capability and lost COMMIT ACK | `ai08-broker-receipt` | SYNTHETIC_UNIT | NOT_TESTED |
| CAS request nested-scope mutation and broker readiness race | `ai08-cas-scope` | SYNTHETIC_UNIT | NOT_TESTED |
| Console D1 claim post-native-readback device/offline/platform/owner switch | external #949/#951 | SYNTHETIC_UNIT | NOT_TESTED (AI-08) |
| Sandbox injected fake kernel evidence and UNKNOWN replay hints | `ai08-enrollment-sandbox` | SYNTHETIC_UNIT | NOT_TESTED |
| Sandbox kernel handles/env/children/network/revoke drain | required #07 physical | ISOLATED_NATIVE_OS | BLOCKED |
| Two-device UAC/CORE verified acceptance / 24h or sleep | owner-auth physical | PHYSICAL_TWO_PC | BLOCKED |

## Komutlar
```bash
node --test --import tsx test/ai08-*.test.ts
npm run typecheck
npm run build
```
**Local exit code / sayı:** NOT_TESTED (tam checkout ve npm dependency yok).  
**GitHub AI-08 exact HEAD / workflow / run ID:** henüz YOK.  
**Yanlış yorumlama yasağı:** önceki PR CI sonuçları AI-08 PASS, OS privilege readback veya fiziksel CORE onayı değildir.
