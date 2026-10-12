# Nexowire AI Screen | Komut masaüstü kaynağı (provenance)

AI ekranına gönderilen komutların ve çalışma alanı kontrollerinin yanıtlarında, gerçek yürütme hedefini açıkça göstermek için ek metadata sağlanmıştır.

- `shell.exec` yanıtındaki mevcut `data.timedOut` korunur; yanına `data.uiTarget` eklenir.
- `workspace.checks` yanıtındaki mevcut `data.root`, `data.parallel`, `data.results` korunur; yanına `data.uiTarget` eklenir.
- Gerçek hedef `private_desktop` olduğunda her iki yanıta `data.desktopName: "NexowirePrivate"` eklenir.
- `headless` hedefi `desktopName` iddiasında bulunmaz.
- Bu alanlar istekle gönderilen değeri körlemesine kopyalamaz; `NEXOWIRE_AI_UI_TARGET_DEFAULT` ve açık `ui_target` kullanılarak hesaplanan, yürütmede kullanılan hedefi bildirir.

Bu, AI Screen görev geçmişinin hangi masaüstüne komut gönderildiğini ayırabilmesi için geriye uyumlu kaynak temeli sağlar. Ancak `headless` bir Win32 izolasyon garantisi değildir; dolaylı `ShellExecute/Explorer/COM` yolları yine ayrıca doğrulanmalıdır.

Windows DEV'de kaynak derlemesi, TypeScript kontrolü, geriye uyumlu MCP şeması ve beş hedefli headless test başarıyla tamamlandı. Özel GUI canlı kabul testi bu çalışma ağacında yeniden çalıştırılmadı; önceki PR'ların canlı Windows kabulü ve GitHub CI kaynakları ayrı değerlendirilmelidir. Üretim #271 ve tam AI ekran kabulü #402 açık kalır.
