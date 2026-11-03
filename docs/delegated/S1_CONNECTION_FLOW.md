# S1-01 — Bağlantı akışı ve güven sınırları

> Yardımcı geliştirici 1 · 2026-10-31T17:34:18+03:00 · main a19a228dc6f19fd484cf935e941a00ea625233f8 · dal docs/delegated-k-s1-20261031.
> Yalnız kaynak/doküman incelemesi; canlı cihaz veya servis deneyi yapılmadı.

## Mevcut kaynak akışı

Ok yönleri protokol çağrısını gösterir; Agent soketi dışarı doğru açar, komut/yanıt aynı bağlantıda iki yönlüdür. Worker bu şemada kimlik/kota kontrol düzlemidir; her native payload'ın Worker'dan aktığı iddia edilmez.

~~~mermaid
flowchart TD
  C["ChatGPT MCP istemcisi"] -->|"HTTPS /mcp"| H["Hub MCP ingress"]
  H -->|"hosted auth ve charge"| W["Worker kontrol düzlemi"]
  W --> D["OAuth ve cihaz/kota kayıtları"]
  H --> R["Yetkili exact-device yönlendirme"]
  R --> B["Hub AgentBroker"]
  A["Native Agent"] -->|"outbound WebSocket /agent"| B
  A -->|"alternatif outbound endpoint"| L["Birinci taraf relay"]
  L -->|"sabit upstream /agent"| B
  B -->|"request ve ACK"| A
~~~

| Adım | Kaynak / gerçek kapsam | Kanıt |
| --- | --- | --- |
| ChatGPT→MCP | README.md, docs/ARCHITECTURE.md; src/mcp/http.ts /mcp middleware ve POST handler. | source-only; güncel ChatGPT bağlantısı UNKNOWN |
| Hosted token | src/mcp/http.ts:resolveMcpAuthorization, src/hub/control-plane-mcp-auth.ts:ControlPlaneMcpClient.authenticate → /api/v1/internal/mcp/authenticate. | Kaynakta hosted credential yolu; local/OIDC seçenekleri ayrı |
| Worker | cloudflare/worker.js: service-role kontrolü, McpOAuthService token doğrulama ve ControlPlaneService kompozisyonu. | Kaynak var; production env/DB durumu okunmadı |
| Metering | ControlPlaneMcpClient.chargeTool → /api/v1/internal/usage/charge; docs/SCALE_V2_S1_WORKER_INGRESS_FANOUT.md. | Normal hosted accepted-tool yolunda auth+charge iki Worker isteği; bütün çağrılara genellenmez |
| Tek çağrı adayı | src/hub/fused-mcp-authorize-charge-client.ts ve cloudflare/worker.js PRODUCTION_FUSED_MCP_AUTH_CHARGE_ENABLED. | TASARIM / DOĞRULANMADI: source helper var, Worker gate kapalı; canlı optimizasyon iddiası yok |
| Cihaz seçimi | src/devices/routing.ts buildDeviceRoutingEntries/filterDeviceRoutes; docs/ARCHITECTURE.md stable ID/alias kuralı. | Liste health/routing verisi yetki veya fiziksel liveness kanıtı değildir |
| Agent auth | src/hub/control-plane-agent-auth.ts:createControlPlaneAgentCredentialVerifier → /api/v1/internal/device/authenticate; src/hub/agent-websocket.ts. | Hosted verifier deviceId döndürür; hello.device.id uyuşmazsa 1008 close. Local bearer ayrı dal, aynı hosted owner garantisi varsayılmaz |
| Komut/ACK | src/core/agent-broker.ts:register/request/handleMessage; src/agent/native-agent.ts. | requestId, current socket, instance ve capability bağları kaynakta; ACK komutun/dış etkinin başarı kanıtı değildir |
| Relay | src/relay/server.ts, src/relay/config.ts; native-agent endpoint fallback. | Birinci taraf WS aktarımı; payload/backpressure/heartbeat sınırları. TURN/WebRTC değildir |

## Oturum açma ve cihaz seçimi

~~~mermaid
flowchart TD
  U["Kullanıcı bağlantı sayfası"] --> G["GitHub OAuth"]
  G --> S["Kontrol düzlemi oturumu"]
  S --> P["Cihaz eşleme ve stable ID"]
  S --> O["ChatGPT OAuth izni"]
  O --> T["MCP erişim belirteci"]
  T --> V["Hub authorization ve tool scope"]
  P --> V
  V --> X["İzinli exact-device hedef"]
~~~

README.md ve docs/INSTALL_WINDOWS.md, indir/kur ve GitHub giriş/BAĞLA ile ChatGPT MCP eklemenin ayrı adımlar olduğunu anlatır. cloudflare/worker.js /auth/github/start, /auth/github/callback, /oauth ve internal MCP authenticate yollarını compose eder. Kullanıcı oturumu, ChatGPT OAuth grant'i, native device credential ve OS/CORE izni birbirinin yerine geçmez.

Worker tarafından dönen allowedDeviceIds/deviceAccessModes/ownerDevices projeksiyonu Hub client'ında parse edilir. Seçilen alias stable ID'ye çözülür; farklı isim/online cihaz aynı yetkili hedef kabul edilemez. İlgili mevcut testler: test/hosted-target-authorization.test.ts, test/mcp-target-authorization.test.ts, test/device-routing.test.ts ve test/device-alias-store.test.ts. Bunlar bu görevde çalıştırılmadı.

## Reconnect / terminal sınırı

~~~mermaid
flowchart TD
  F["Bağlantı veya ACK kaybı"] --> M{"Bekleyen mutation mı?"}
  M -->|"evet"| N["Otomatik redispatch yok"]
  N --> Q["UNKNOWN veya instance-change hatası"]
  M -->|"hayır"| K{"Cihaz, capability ve bütçe uygun mu?"}
  K -->|"evet"| R["Aynı request ID ile sınırlı read-only resume"]
  K -->|"hayır"| E["Açık hata; farklı hedefe sessiz geçiş yok"]
  Q --> J["Salt-okunur journal inceleme; terminal UNKNOWN korunur"]
~~~

src/core/agent-broker.ts:resumePending mutation'ı aynı instance için MUTATION_STATE_UNKNOWN, değişen instance için AGENT_INSTANCE_CHANGED ile reddeder. Read-only replay bütçesi ve capability kontrolü ayrıdır. register yeni socket/epoch kurar; handleMessage eski socket ACK/event'ini kabul etmez. src/agent/native-agent.ts:planNextHubAttempt ordered endpoint fallback ve bounded backoff/jitter kullanır; fiziksel NAT başarısı çıkarılamaz.

src/operations/agent-connection-journal-reconciliation.ts, Hub target/fingerprint ve bağımsız Agent fingerprint sözleşmesini trusted authenticatedDeviceId ile kontrol eder. Bu helper canlı retrieval veya retry yapmaz; externalSideEffectProven=false ve automaticallyRetryable=false sınırı korunur. Agent terminal metadata Hub UNKNOWN kaydını otomatik temizlemez.

## Tasarım / doğrulanmayan bağlantılar

- Native P2P, STUN/TURN, ICE veya simetrik NAT hole punching: TASARIM / DOĞRULANMADI. Bu kaynak diliminde bunları varmış gibi gösteren akış yok.
- Public owner-quota WSS prototipleri native /agent yolu değildir; docs/SCALE_V2_S2_OUTBOUND_OWNER_WS.md loopback/dev sözleşmesini ayrı tanımlar.
- docs/SCALE_V2_S1_EPOCH_TOOL_ADMISSION.md request-time owner/session adayını açıklıyor; iki SQL okuması OS effect-boundary atomik yetki/revocation kanıtı değildir.
- Gerçek TLS inspection/proxy/CGNAT, relay finansal bütçesi ve iki cihazın bugün online olması UNKNOWN. Hiçbir endpoint aranmadı, listener/Agent/Broker başlatılmadı.
