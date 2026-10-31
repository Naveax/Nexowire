# S1-02 — NAT ve bağlantı kabul matrisi

> Yardımcı geliştirici 1 · 2026-10-31T17:34:18+03:00 · main a19a228dc6f19fd484cf935e941a00ea625233f8 · dal docs/delegated-k-s1-20261031.
> Yalnız kaynak/doküman incelemesi; canlı cihaz veya servis deneyi yapılmadı.

Bu bir test planıdır. Bütün satırların observed/result alanı NOT_RUN; gerçek ağ sonucu UNKNOWN. Önkoşullar gelecekteki yetkili, atılabilir lab içindir; bu görev bunları kurmaz veya ayar değiştirmez. Fiziksel/proxy/TLS testleri ayrıca owner/lab izni gerektirir. Endpoint/token/cihaz kimliği rapora kopyalanmaz.

| Durum | Önkoşul | Beklenen güvenli davranış | Test türü | Dış bağımlılık | Gözlem metriği | Bilinen / UNKNOWN |
| --- | --- | --- | --- | --- | --- | --- |
| LAN | Ayrı lab istemci ve yetkili TLS Hub | Exact-device auth korunur; TCP erişimi tek başına başarı değildir | Lab planı | DNS/TLS/Hub | handshake, ACK, hedef eşleşmesi | Outbound WS kaynakta; gerçek LAN UNKNOWN |
| Mobil hotspot | Atılabilir lab, ayrı hotspot izni | Outbound tekrar açılır; kopan mutation tekrar edilmez | Fiziksel lab planı | Mobil operatör/DNS | reconnect süreleri, UNKNOWN sayısı | NAT/operatör kabulü UNKNOWN |
| Çift NAT / CGNAT | Gerçek lab topolojisi ve doğrulanmış outbound yol | Inbound port gerektirmeden yetkili Hub/relay denenir; ulaşılmazsa açık offline | Lab planı | Operatör/edge | upgrade oranı, timeout, endpoint sınıfı | Outbound mimari var; CGNAT sonucu UNKNOWN |
| Simetrik NAT | Ayrı ağ laboratuvarı | Hole punching garantisi yok; izinli outbound yol varsa kullanılır, aksi offline | Lab planı | NAT lab/Hub | direct/relay sonucu, hata sınıfı | P2P TASARIM / DOĞRULANMADI |
| IPv4-only | A kaydı ve IPv4 lab | TLS hostname ve credential aynı kurallarla doğrulanır | Lab planı | Resolver/IPv4 rota | DNS→connect→TLS→hello süreleri | Gerçek IPv4 kabulü UNKNOWN |
| IPv6-only / dual-stack | AAAA/NAT64 ve dual-stack ayrı lab profilleri | Yanlış host/IP kimliğine fallback yok; aile başarısızsa bounded hata | Lab planı | Resolver/IPv6 edge | adres ailesi, hata, gecikme | IPv6 davranışı UNKNOWN; Happy Eyeballs garantisi yok |
| UDP kapalı | Ayrı lab güvenlik politikası | WS/TLS TCP yolu varsa sürebilir; UDP/P2P mecbur varsayılmaz | Lab planı | TCP/DNS erişimi | WS handshake, DNS hata sınıfı | UDP kapalı kabulü UNKNOWN; bu görev ağ kuralı değiştirmez |
| Kurumsal proxy | Yetkili proxy test profili; gerçek credential yok | Desteksiz proxy açık hata; credential sızdırma/TLS bypass yok | Mock sözleşme + lab planı | Proxy/CONNECT/WS upgrade | 407/upgrade/timeout, redaction | Proxy desteği/acceptance UNKNOWN |
| TLS inspection | Atılabilir TLS lab ve test CA | Hostname/cert güveni korunur; doğrulanmayan peer reddedilir; validation kapatılmaz | Negatif lab planı | TLS trust/issuer | cert hata sınıfı, dispatch=0 | Üretim CA/pin uyumu UNKNOWN |
| DNS hatası | Sahte resolver veya izole lab fault | Bounded bağlantı hatası; sabit IP ile kimliği dolaşma yok | Mock planı; lab ayrı | Resolver | DNS failure, deneme aralığı | Gerçek DNS kesintisi UNKNOWN |
| İnternet kesintisi | İzole route-fault fixture; üretim kesilmez | Backoff/heartbeat/offline; mutation UNKNOWN; read-only sınırlı resume | Mevcut fixture kaynak indeksi; NOT_RUN | Fixture/yerel WS (ayrı izinli yürütme) | epoch, ping/pong, grace, redispatch=0 | connection-recovery-faults kaynakta; fiziksel UNKNOWN |
| Relay tükenmesi | Sentetik bütçe/backpressure girdisi | Paid kapasiteye sessiz geçiş yok; deny/degrade, mutation replay yok | Model/lab planı | Yetkili bütçe ledger/relay | bytes, 1013, reddetme, fatura ölçümü ayrı | Kaynak queue sınırı var; finansal hard-stop kabulü UNKNOWN |
| Relay tamamen erişilemez | Sentetik endpoint hata dizisi | Yalnız önceden izinli endpoint sırası; yanlış tenant/hedef yok | Mock/lab planı | Direct ve relay altyapısı | attempt sınıfı, backoff, terminal hata | Endpoint planı kaynakta; remote failover UNKNOWN |

## Ortak ölçüm ve kabul kuralları

Her satır için 02_EVIDENCE_TEMPLATE.md alanları doldurulur: ID, kaynak issue #483/#482, exact branch/SHA, komut, OS/Node, timezone'lu tarih, beklenen/gözlenen, CI ID, engel. Başlangıç ve bitişte aynı sentetik stable ID/owner, socket epoch ve request ID izlenir. Mutation dispatch sayısı <=1; kayıp ACK'de başarı uydurulmaz. Aynı test esnasında ikinci sentetik cihazın devamlılığı ayrıca ölçülür.

Ölçülecek süreler birim ve örnek sayısıyla raporlanır; SLO eşikleri ana ekipçe belirlenmediği için UNKNOWN. Tek örnekten p95/kapasite çıkarılmaz. Retry sayısı, reconnect count, heartbeat/ACK ve açık hata sınıfları tutulur; credential, payload ve kullanıcı yolu loglanmaz. İptal edilmiş test PASS sayılmaz.

## Kaynaklar ve sınırlar

- src/agent/native-agent.ts: reconnectWaitMs / planNextHubAttempt, endpoint doğrulama ve fallback.
- src/hub/agent-websocket.ts: auth, hello/device binding, heartbeat.
- src/core/agent-broker.ts: getConnectionHealth, resumePending, mutation UNKNOWN ve read-only bütçesi.
- src/relay/server.ts: maxPayloadBytes, bufferedAmount, startup queue ve 1013 backpressure; bu provider fatura hard-stop'u değildir.
- docs/SCALE_V2_S1_METRICS.md: uygulama byte/counter'ları TCP/TLS wire bytes veya cloud fatura metriği değil; process-local/opt-in.
- docs/SCALE_V2_CONNECTION_ROLLOUT.md ve #483: staged rollout / gerçek iki cihaz kanıtı ayrı.
- docs/SCALE_V2_S2_OUTBOUND_OWNER_WS.md: loopback owner-quota prototipi public native Agent kabulü değil.

Mevcut test/connection-fault-proxy.e2e.test.ts ve test/connection-recovery-faults.test.ts uygun sentetik fault örnekleri sunar; bu belgeleri hazırlarken çalıştırılmadı. NAT sınıfı ölçülmedi; router, VPN, DNS, firewall, CA veya proxy ayarı değiştirilmedi.
