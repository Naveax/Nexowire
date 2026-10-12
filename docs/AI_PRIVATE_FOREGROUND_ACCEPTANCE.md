# Nexowire AI Screen | Gerçek Windows odak ve imleç kabul testi

## Kapsam

`test/private-ai-focus-soak.test.ts`, sahibi tarafından açılmış Windows oturumunda AI'nın ayrı masaüstü üzerinden çalıştığı sırada normal kullanıcı ekranına müdahale edilmediğini **işletim sistemi verileriyle** doğrulayan, yalnızca açıkça etkinleştirilen bir DEV kabul testidir.

Sırasıyla şu kaynak yolları çalıştırılır:

1. Varsayılan `private_desktop` hedefine yönlenen `shell.exec`.
2. Yeniden bağlanabilir `process.start` oturumu.
3. Bağımlılık içeren iki `task.graph.run` komutu.
4. İki paralel `workspace.checks` test/derleme işi.
5. Görünür Edge oturumu ve CDP bağlantısı.
6. Ön plana çıkmayan AI Viewer ve kapanışı.

Her adım sonrasında salt-okunur Windows API bilgileri tekrar alınır:

- `GetForegroundWindow`: Kullanıcının aktif HWND'si değişmemeli.
- `GetCursorPos`: Gerçek fare imlecinin X/Y koordinatları aynı kalmalı.
- `GetLastInputInfo`: Test başlamasından beri fiziksel input etkinliği değişmemeli.
- `windows.private_desktop.status`: `inputDesktop=Default` kalmalı.

**Önemli:** `GetLastInputInfo` insan girişini AI girişinden ayıramaz. Kullanıcı DEV masaüstünü kullanıyorsa test hata verir ve sonuç **kararsızdır**; bu sonuç otomatik olarak AI'nın input enjekte ettiğini kanıtlamaz. Yalnızca boş/izole DEV oturumunda test yapılmalı ve tekrarlanmalıdır. Gerçek üretim masaüstüne hiçbir test dağıtılmaz.

## Yerel kullanım

Windows DEV bilgisayarında izole checkout içerisinden:

```powershell
$env:NEXOWIRE_RUN_AI_FOCUS_SOAK_LIVE='1'
node --test --import tsx test/private-ai-focus-soak.test.ts
Remove-Item Env:NEXOWIRE_RUN_AI_FOCUS_SOAK_LIVE
```

Bu test gerçek Windows masaüstünde ayrı host, Edge, WPF viewer ve geçici işlemler başlatır. Test kendi oluşturduğu geçici durumları, özel masaüstünü ve browser oturumlarını kapatır; görünür yerel AI Viewer bir pencere olarak açılır, ancak aktive etmemelidir. Normal CI çalışmasında bu test adımı atlanır; CORE/ROOT/Broker/yükseltilmiş görev veya Windows UAC etkinleştirme yapılmaz.

## Sonuç ve sınırlamalar

12 Ekim 2026 DEV çalışmasında tam akış **20 saniyelik bir örneklemde geçti**. Önceki deneme işlem sırasında yeni input olayı gördüğünden kararsız kaldı; ikinci çalışma aktif HWND, fiziksel imleç, son giriş zaman damgası ve `Default` masaüstünün değişmediğini doğruladı.

Bu sonuç tam gün boyunca odak kaybı olmayacağını veya `ShellExecute`, `Explorer`, `COM`, UAC, oturum kilitleme/yeniden giriş, DPI/çoklu monitör ve sistem izin pencerelerinin tamamen izole edildiğini **kanıtlamaz**. Üretim geçişi için #402'de daha uzun bağımsız kabul, #271'de korunmuş ACL/handoff ve sahip onayı gerekir.
