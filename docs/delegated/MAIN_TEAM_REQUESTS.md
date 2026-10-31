# K03 — Ana ekip talepleri / yalnız yardımcı 1

> Yardımcı geliştirici 1 · 2026-10-31T17:34:18+03:00 · main a19a228dc6f19fd484cf935e941a00ea625233f8 · dal docs/delegated-k-s1-20261031.
> Yalnız kaynak/doküman incelemesi; canlı cihaz veya servis deneyi yapılmadı.

Diğer yardımcıların talepleri alınmadı; koordinatör birleştirecek. Aşağıdakiler uygulanmış değişiklik veya güvenlik kabulü değildir.

| ID / issue | Kaynak ve bulgu | Öneri / owner / hedef | Kabul testi | Risk / durum |
| --- | --- | --- | --- | --- |
| K-S1-REQ-01 / #483 | src/operations/agent-connection-journal-reconciliation.ts, reconcileConnectionBoundAgentOperation: authenticatedDeviceId güvenilir exact-device rotadan gelmeli; helper canlı retrieval yapmıyor. | Ana ekip yetkili salt-okunur retrieval kompozisyonunu değerlendirsin; adapter ve çağıran product/MCP katmanı. | Yanlış owner/device, alias değişimi, farklı Hub/Agent hash kontratı, eksik provenance, offline ve kayıp ACK; Hub UNKNOWN ve zero redispatch korunmalı. | Forged metadata ile sahte başarı. PROPOSED_NOT_IMPLEMENTED. |
| K-S1-REQ-02 / #483 | HANDOFF same-process pending continuity anlatımı mutation ayrımını yeterince açık vermiyor; src/core/agent-broker.ts:resumePending aynı instance dahil mutation replay reddeder. | Doküman owner'ı HANDOFF.md ve docs/CONTINUATION.md açıklamasını güncel kaynakla uzlaştırsın. | test/native-session-continuity.test.ts aynı/yeni instance mutation negatifleri aynen kalsın; read-only bütçesi ayrı anlatılsın. | Operatörün belirsiz işi tekrar çalıştırması. PROPOSED_NOT_IMPLEMENTED. |
| K-S1-REQ-03 / #485, #974 | installers/README.md v1.0.7 ZIP/bootstrap anlatıyor; main package ve release kaydı 1.0.8. | Installer/onboarding owner'ı kanal farkını açıklasın; installers/README.md, docs/INSTALL_WINDOWS.md ve web/connect.js URL/pinlerini doğrulasın. Otomatik pin değiştirilmedi. | Sunulan URL→tag→hash→payload eşleşmesi, corrupt-download reddi ve Unicode clean-profile CI; yayıncı imzası ayrıca. | Yanlış sürümü güncel sanma / güvenilmeyen bootstrap. PROPOSED_NOT_IMPLEMENTED. |
| K-S1-REQ-04 / #483, #487 | docs/SCALE_V2_S1_METRICS.md process-local byte/counter; NAT sınıfı, provider faturası veya public ağ kabulü değil. #483 closed bütün lab matrisi kanıtı değil. | Koordinatör ağ QA owner'ı ve ayrı izinli lab/staging kanıt işini atasın; S1_NETWORK_MATRIX ve S1_RECONNECT_CASES kayıtları ileride doldurulsun. | Her NAT/proxy/TLS/DNS/relay satırında exact SHA+ortam+redakte gözlem; bu görevde ağ ayarı/üretim yükü yok. | Loopback sonucunu evrensel bağlantı garantisi sanma. PROPOSED_NOT_IMPLEMENTED. |

Ortak kaynak SHA başlıkta. Hiçbir canonical dosya, CORE/Broker/auth kodu, servis veya ağ ayarı değiştirilmedi. Gerçek cihazın güncel durumu UNKNOWN.
