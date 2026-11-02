# S1-03 — Reconnect ve kesinti kabul senaryoları

> Yardımcı geliştirici 1 · 2026-10-31T17:34:18+03:00 · main a19a228dc6f19fd484cf935e941a00ea625233f8 · dal docs/delegated-k-s1-20261031.
> Yalnız kaynak/doküman incelemesi; canlı cihaz veya servis deneyi yapılmadı.

## Yürütme durumu

Bu 30 isimlendirilmiş senaryonun tamamı TEST PLANI: observed=NOT_RUN, result=NOT_RUN. Kaynak eşlemesi testin her ayrıntısının mevcut testte kapsandığı veya geçtiği iddiası değildir. Kod/test adları gerçekten incelenmiş başlangıç noktalarıdır. Canlı servis deneyi, ağ değişikliği veya localhost listener bu görevde çalıştırılmadı.

Ortak önkoşul: sentetik fixture-device-a/b, fixture-op-01, sahte credential/clock/store, dış endpoint'siz izole geliştirici lab. Fiziksel ağ/Windows veya staging adımı ayrı owner izni ve atılabilir ortam gerektirir. Mevcut loopback fixture'lar socket açtığından bu görev yalnız indeksler.

**Değişmez kabul:** Mutation tekrar çalıştırılmaz; UNKNOWN terminal kalır. Kayıp ACK'de dispatch sayacı birden fazla artamaz. Agent succeeded metadata, Hub UNKNOWN'u silmez ve externalSideEffectProven anlamına gelmez. Salt okuma resume, salt-okunur journal retrieval ve artifact chunk resume farklı sözleşmelerdir.

| ID / ad | Fault / kurulum | Beklenen güvenli sonuç | Kaynak / kapsam eşlemesi |
| --- | --- | --- | --- |
| S1-03-R01 — Kayıp mutation ACK | Mutation fixture yan-etki sayacını 1 yapar, ACK yerine socket kapanır | MUTATION_STATE_UNKNOWN; Agent metadata başarı desin bile Hub UNKNOWN korunur; redispatch=0 | test/connection-journal-reconciliation.test.ts |
| S1-03-R02 — Gecikmiş ACK | Deadline sonrası eski ACK verilir | Timeout UNKNOWN sonradan success olmaz; pending temizlenmişse ACK yok sayılır | test/connection-recovery-faults.test.ts |
| S1-03-R03 — Aynı süreç reconnect | Aynı instanceId yeni socket ile döner | Bekleyen mutation yeniden gönderilmez; MUTATION_STATE_UNKNOWN | test/native-session-continuity.test.ts |
| S1-03-R04 — Yeni süreç reconnect | Aynı stable deviceId, yeni instanceId | Mutation AGENT_INSTANCE_CHANGED; etkisi UNKNOWN; yeniden çalışma yok | test/native-session-continuity.test.ts |
| S1-03-R05 — Salt okuma resume | İzinli read-only capability; socket kopar | Aynı requestId ile bounded resume; başka cihaz seçilmez | test/native-session-continuity.test.ts |
| S1-03-R06 — Read-only bütçe biter | İzinli tekrar sayısından fazla reconnect | AGENT_RETRY_LIMIT; sonsuz retry yok | test/connection-recovery-faults.test.ts |
| S1-03-R07 — Stale socket ACK/event | Eski soketten replacement sonrası frame | Eski ACK pending isteği kapatmaz; stale event yayımlanmaz | test/connection-recovery-faults.test.ts |
| S1-03-R08 — Duplicate Agent | Aynı deviceId ikinci yetkili socket | Önceki socket fence edilir, epoch artar; mutation tekrar gönderilmez | test/connection-fault-proxy.e2e.test.ts |
| S1-03-R09 — Farklı cihaz aliası | Alias başka stable ID gösterir veya hedef offline olur | Yetki/target tekrar doğrulanmalı; farklı cihaza sessiz dispatch yok | test/device-alias-store.test.ts |
| S1-03-R10 — Heartbeat yok | Current socket pong üretmez | heartbeat_timeout ayrı gözlenir; offline; bekleyen mutation belirsiz | test/connection-recovery-faults.test.ts |
| S1-03-R11 — Grace süresi dolar | Agent deadline içinde geri dönmez | Mutation UNKNOWN, read-only açık timeout/offline sonucu; success yok | test/connection-recovery-faults.test.ts |
| S1-03-R12 — Offline exact target | A offline, B online | AGENT_OFFLINE; B kendiliğinden A yerine seçilmez | test/connection-recovery-faults.test.ts |
| S1-03-R13 — Cross-device forged ACK | B, A requestId ile ACK gönderir | A tamamlanmaz; current socket/device bağları korunur | test/connection-fault-proxy.e2e.test.ts |
| S1-03-R14 — Capability kaldırıldı | Read-only request sonrası reconnect capability listesinde yok | AGENT_CAPABILITY_CHANGED; başka yetkiye/cihaza fallback yok | test/connection-recovery-faults.test.ts |
| S1-03-R15 — Credential revoke | Kopan mutation sonrası fresh upgrade revoked credential taşır | Fresh handshake reddi; mutation tekrar yok; canlı credential kullanılmaz | test/connection-fault-proxy.e2e.test.ts |
| S1-03-R16 — OAuth grant expiry | Sahte saatle süresi dolan MCP token | Yeni admission reddi; eski işlem başarı sayılmaz; çalışan etki otomatik iptal edilmiş varsayılmaz | test/mcp-oauth.test.ts |
| S1-03-R17 — Logout / session değişimi | Test store session epoch değiştirir | Yeni request-time admission reddi; in-flight OS revocation kanıtı değil | test/mcp-oauth-epoch-tool-admission-staging.test.ts |
| S1-03-R18 — İptal ile ACK yarışı | Dispatch sonrası cancellation önce gelir | İptal isteği effect rollback kanıtı değil; UNKNOWN yeniden çalıştırılmaz | TASARIM / DOĞRULANMADI: effect-boundary owner testi gerekli |
| S1-03-R19 — Yarım JSON / hello | Tamamlanmamış veya şemaya aykırı mesaj | Handshake/protocol reddi; geçerli yetki veya başarı üretilmez | src/hub/agent-websocket.ts |
| S1-03-R20 — Artifact yarım payload | Chunk ortasında kesinti, exact offset/SHA korunur | Yalnız uygun chunk resume; kaynak SHA değişirse publish yok; komut mutation replay ile karıştırılmaz | test/connection-artifact-chunk-faults.test.ts |
| S1-03-R21 — Relay failure | Sentetik direct/relay rota düşmesi | İzinli endpoint planı/backoff; mutation UNKNOWN ve no replay | src/agent/native-agent.ts |
| S1-03-R22 — Relay backpressure | Sentetik queue/payload limitini aş | Bounded queue/close; paid kapasiteye otomatik geçiş yok | src/relay/server.ts |
| S1-03-R23 — Yanlış owner | Foreign cihaz için geçerli başka hesap tokenı | Admission deny; owner izinleri socket varlığıyla kazanılmaz | test/hosted-target-authorization.test.ts |
| S1-03-R24 — Device credential mismatch | Verifier A döndürür; hello B taşır | 1008 close; broker.register öncesi reddi | src/hub/agent-websocket.ts |
| S1-03-R25 — Auth fail / verifier outage | Geçersiz token ile verifier servis hatası ayrı üretilir | Token 401/reauthorize; MCP verifier outage 503/retry_later; fail-open yok | src/mcp/http.ts |
| S1-03-R26 — Journal provenance eksik | Agent row var fakat authenticatedDeviceId yok/yanlış | journal_mismatch UNKNOWN; automaticallyRetryable=false | test/connection-journal-reconciliation.test.ts |
| S1-03-R27 — Aynı UUID değişen payload | Hub ve Agent fingerprint farklı kontratta hesaplanır; payload veya accessMode değişir | Mismatch reddi; yeni UUID ile UNKNOWN dolaşılmaz | test/connection-journal-reconciliation.test.ts |
| S1-03-R28 — İki cihazdan biri kopar | A bağlantısı giderken B read-only bekliyor | B kendi requestId/ACK ile devam eder; cross-resolve yok | test/connection-recovery-faults.test.ts |
| S1-03-R29 — DNS / internet uzun outage | Sentetik resolver ve endpoint hata dizisi | Bounded backoff; credential sızması/insecure downgrade yok; mutation terminal kalır | src/agent/native-agent.ts |
| S1-03-R30 — Hub restart / eksik Agent row | Hub UNKNOWN kaydı var; Agent terminal metadata eksik | record_missing/unknown, otomatik retry yok; gerçek restart dayanıklılığı ayrıca kanıtlanır | src/operations/agent-connection-journal-reconciliation.ts |

## Her senaryonun kanıt toplama ve kabul adımları

1. 02_EVIDENCE_TEMPLATE alanlarını aç: ID, issue #483/#482 (journal için #974 bağlamı), branch/exact SHA, tam komut, OS/Node, tarih/timezone, CI ID ve engel.
2. Sentetik operasyonu tek kez kabul ettir; başlangıç owner/device, requestId, socket epoch/instance, payload fingerprint ve dispatch sayacını yalnız test belleğinde kaydet.
3. Tablodaki fault'u yalnız fixture sınırında uygula. Beklenen hatanın doğru katmandan geldiğini kaydet: auth, transport, Agent receipt, komut sonucu ve dış postcondition ayrı.
4. Deadline/reconnect sonrası yeni/eskimiş ACK ve callback'leri tamamla. Terminal mutation için dispatch artışı=0, UNKNOWN tombstone korunumu, başka cihazda effect=0 doğrula.
5. Read-only için aynı requestId ve tanımlı retry bütçesini doğrula; capability/owner değişiminde otomatik yeniden yetkilendirme varsayma.
6. Yalnız redakte sayılar/hata sınıfı/sentetik ID yaz; gerçek credential/payload/path yok. Eksik önkoşul BLOCKED, çalıştırılmayan test NOT_RUN; beklenen sonuç PASS değildir.

## Güvenlik ve bilgi sınırı

src/core/agent-broker.ts:resumePending kaynak davranışı authority, CAS, CORE veya Broker OS izni oluşturmaz. docs/SCALE_V2_S1_EPOCH_TOOL_ADMISSION.md iki kontrolün in-flight effect revocation garantisi olmadığını açıklar. Auth fail testleri gerçek OAuth hesabı/secret kullanmamalı. Kalıcı grant/enrollment expiry sözleşmeleri #980–#984 ekibinin alanıdır; MCP OAuth expiry ile karıştırılmaz.

Gözlem metrikleri: epoch/reconnectCount, lastDisconnectReason, heartbeat ping/pong/ACK count, bounded süreler (ms), requestId/device eşleşmesi, logical invocation sayısı, dispatch/replay sayısı, Hub status ve Agent evidenceVerified/externalSideEffectProven ayrımı. Varsayılan sayaçlar cloud faturası, fiziksel Exactly Once veya NAT başarısı değildir. Eşik/SLO owner tarafından belirlenmediyse UNKNOWN.
