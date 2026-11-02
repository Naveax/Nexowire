> Yardımcı 4 / 31 Ekim 2026 / belge ve sentetik test kapsamı.
> Kaynak tabanı: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main).
> Dal: `docs/delegated-r-rel-20261031`. AGENTS.md bulunmadı.
> Kaynak bağlantıları aşağıdaki göreli yollar için bu exact SHA üzerinden okunmalıdır:
> https://github.com/Naveax/Nexowire/tree/a19a228dc6f19fd484cf935e941a00ea625233f8
> Bu çalışma cihaz kabulü, güvenlik onayı veya üretim PASS değildir.

# R-02 — Hata ve sonuç sözlüğü

[#539](https://github.com/Naveax/Nexowire/issues/539) AÇIK. R01/R03/R04/R13/R18 backlog başlıklarıdır; bunlar wire error code değildir.

| Backlog | Anlam / kaynak bağlantısı | Sınır |
|---|---|---|
| R01 | Provider rejection, MCP transport, Agent receipt, command exit, task result ayrı | Transport başarı komut başarısı değildir |
| R03 | Read-only status/reconciliation ve Hub offline geçmişi | Status sorgusu mutation replay değildir |
| R04 | FULL/ROOT/CORE/Windows/UAC/console yetki tanısı | Erişim reddi gevşetilmez |
| R13 | Upstream/provider safety denial kaynağı | Yerel CORE sağlayıcı reddini aşmaz |
| R18 | Process progress/queue watchdog | Yaşayan PID veya RUNNING completion değildir |

## Katmanlar ve gözlem

| Durum | Gözlem / gerçek kaynak | Yorum ve güvenli sonraki adım |
|---|---|---|
| HTTP 401 | HTTP kimlik doğrulama katmanı; `src/mcp/http.ts:250,275`, `MCP_AUTH_REQUIRED` | Eksik/geçersiz credential olasılığı; path, endpoint ve response code birlikte kaydet. Broker health unauthenticated 401 beklenen olabilir (#974). Otomatik yeniden kimlik kurma yok |
| HTTP 403 | `src/mcp/http.ts:301`, `MCP_TOOL_NOT_AUTHORIZED` | Kimlik doğrulanmış olsa da kapsam/cihaz yetkisi yeterli olmayabilir. Tool allowlist reddi bu handler için doğrulanmıştır; diğer endpoint nedenleri ayrı doğrulanmalı |
| HTTP 409 | Çakışma/idempotency/replay bağlamı | `cloudflare/worker.js:492,533` içindeki `SETUP_ALREADY_CONFIGURED` setup çakışmasıdır. Her 409 replay değildir; request/operation ID ve gerçek kodu koru; mutation tekrar etme |
| `PERMISSION_DENIED` | `mcp-agent-outcome-reconciliation.test.ts` | Failed olarak kalıcı kayıt; yeniden çağrı error cache döndürür, broker bir kez çağrılır |
| `PATH_DENIED`, `MCP_TARGET_NOT_AUTHORIZED`, `UNAVAILABLE` | #539'da bildirilen ayrımlar | Yol, hedef yetkisi, erişilebilirlik farklıdır; denial bypass önerilmez. Tüm handler eşlemeleri bu belgede tamamlanmış sayılmaz |
| Transport fail | Kanal/bağlantı başarısız | Komutun hiç ulaşmadığı kanıtlanmadıkça tekrar güvenli sayılmaz |
| Agent receipt | İstek Agent tarafından görüldü/kaydedildi | İşin bitişi veya postcondition başarısı değildir |
| Exit 1 / nonzero | `agent-provider-task-outcome.test.ts`, `qa-shell-outcome-negative.test.ts` | `ok:true` transport ile birlikte `taskStatus:failed`, `taskSuccess:false` olabilir |
| Exit 0 + timedOut | Aynı testler | `timed_out`, taskSuccess false; exit 0 timeout'u geçersiz kılmaz |
| Exit null/eksik/yanlış tip | Aynı testler | `unknown`, taskSuccess null; başarılı diye gösterme |
| Lost ACK / unknown completion | `AGENT_OPERATION_COMPLETION_UNCONFIRMED` / reconciliation testi | Durable unknown; aynı mutation otomatik yürütülmez |
| Önceden kaydedilmiş operation | `AGENT_OPERATION_ALREADY_RECORDED` / aynı test | Durable unknown; cached error ve replayed işareti yeni yürütme değildir |
| Journal corruption | `AGENT_JOURNAL_WAL_CORRUPT` / WAL integrity testi | Başlangıç/dispatch fail-closed; dosyayı silme veya recovery önerme |
| UI offline | Arayüzün görüntülediği durum | Tek başına runtime offline kanıtı değil; timestamp, hedef ve stale state kontrolü |
| Runtime offline | Hub bağlantısı/last seen ve salt-okunur status | Broker ayrı online olabilir (#974); tüm bileşenleri offline diye toplama |
| RUNNING / canlı PID | #539 R18 | Tamamlanan iş, çıktı ve postcondition ayrıca ölçülür |

`HTTP 401/403/409` durum sınıfıdır; tüm servislerde aynı uygulama koduna eşit değildir. Kaynağı bilinmeyen kodu UNKNOWN bırak. HTTP/body, transport, receipt, exitCode, timedOut, taskStatus, taskSuccess ve postcondition alanlarını ayrı sütunlarda raporla. Payload/credential/log dökümü ekleme; yalnız sentetik örnekler kullan.

## Örnek (sentetik)

`HTTP 200; transport ok=true; receipt=recorded; exitCode=1; timedOut=false; taskStatus=failed; taskSuccess=false; postcondition=not_tested` → komut başarısız. `ACK kayıp; exitCode=null; durableStatus=unknown` → durum belirsiz, mutation tekrar yok. Salt-okunur reconciliation sonucu gelmezse unknown terminal kalır.

Bu belge hata kodu icat etmez, product error contract değiştirmez. Hedef handler bulunamadığında karşılık DOĞRULANMADI olarak raporlanır.
