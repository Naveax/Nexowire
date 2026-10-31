# AI-08 | Bağımsız adversarial QA sözleşmesi

## Sahiplik ve sınır
Sadece `test/ai08-*.test.ts`, `test/fixtures/ai08/**` ve `docs/ai-handoff/AI-08/**` yazılır. Üretim kaynakları, CI workflow, main, diğer ajanların testleri, cihazlar ve servisler salt-okunurdur. Bu branch `9d0f35607d4cde87bd031e2da77855cfaf570c31` SHA'sındaki #984 üzerine dayanır; bağımlılık zinciri **#984 → #983 → #982 → #981 → #980 → main**. Bu zincir birleştirilmiş production kabulü değildir.

## Dışarıdan beklenen API/semantik
- **WAL:** `verifyAgentJournalWal` gerçek SQLite RESTART/reuse sonrası geçerli committed prefix'i kabul eder; current-frame checksum/torn/SHM disagreement/replay fail-closed. DB/WAL/SHM otomatik onarılmaz.
- **CORE enrollment:** `verifyPersistentEnrollmentSession` yerel imza, owner SID, machine binding, generation, revoke ve fresh session/binding eşleşmesini zorunlu kılar. `expiresAt:null` tek başına yetki veya fiziksel kabul değildir.
- **mTLS:** `createCoreNativeMtlsFetch` HTTPS+TLS1.3, pinned SPKI, sabit origin ve katı istek şekliyle çalışır. Yanlış pin/redirect/abort UNKNOWN/deny; otomatik retry yok.
- **Broker receipt:** `invokeBrokerEffectOnce` imzalanmış **değişmez** payload bytes'ı verifier'a aktarır. Yanlış capability/owner/nonce ve COMMIT ACK kaybı callback'i tetiklemez. Testteki sahte imzalar gerçek Broker sertifikası değildir.
- **External CAS:** `BrokerExternalDispatchFence` immutable request ID + nested scope üzerinden begin/commit/release yapar; signed receipt scope farkı ve native Broker readback kaybında deny. Durabilen backend tombstone fiziksel olarak burada ölçülmez.
- **Console:** D1 claim sırasında ve sonrasında owner/device/platform/readiness yeniden doğrulanır; revoke/UNKNOWN/replay terminal ve fail-closed. #949 RED yalnız #951 source fix ile kapanmış sayılmaz.
- **Sandbox:** `prepareSandboxRequiredCapability` ve `executeSandboxRequiredCapability` kaynak adaptörü çağrıları hiçbir gerçek process effect başlatamaz. Native low-privilege, env/handle/network, child/descendant ve revoke cleanup ayrı kernel kanıtı ister.

## Kanıt sınıfları
`SYNTHETIC_UNIT` (sahte owner/crypto/OS), `DISPOSABLE_SQLITE`, `LOCAL_TLS_LOOPBACK`, `ISOLATED_NATIVE_OS`, `STAGING`, `PHYSICAL_TWO_PC`. Bir alt seviye üst seviye PASS sayılmaz. `PASS/FAIL/BLOCKED/NOT_TESTED` yalnız ölçülmüş exact SHA+run ID'ye bağlanır.
