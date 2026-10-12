# Nexowire AI özel masaüstü | Workspace Checks

`workspace_run_checks` MCP komutuna isteğe bağlı
`ui_target: "private_desktop"` veya `"headless"` eklendi.
`private_desktop` modunda seçilen derleme/test/lint/typecheck
komutları doğrudan `NexowirePrivate` Win32 masaüstüne bağlı
süreçler olarak başlatılır. Önceden gelen çağrılarda varsayılan
`headless` davranışı değişmez. Ayrı masaüstü kullanılamadığında
görünür kullanıcı masaüstüne sessiz geçiş yapılmaz.

## Paralel iş güvenliği

Birden fazla paralel kontrol başladığında private desktop host
başlatma, kapatma ve uygulama başlatma eylemleri aynı modülde
bir **asenkron seri kuyruk** üzerinden geçirilir. Bu, eşzamanlı
başlatmaların `state.json` ve ortak `.tmp` üzerine birbirini
ezmesini ve açılan PID listesinin kaybolmasını önler. Kuyruk,
bir işlem hata verse bile diğerlerini işletir. Kuyruk yalnız
aynı Node agent süreci içindeki eylemleri koordine eder;
farklı agent süreçleri/oturumlar için çapraz süreç kilidi değildir.

Windows DEV canlı testinde `parallel:true` ile iki bağımsız
Node tabanlı npm test/build komutu çalıştırıldı, çıktıları
alındı ve kullanıcı input masaüstünün `Default` kaldığı
doğrulandı. Test özel GUI oturumunu kendisi temizler.

Bu kaynak kodu değişikliği tüm AI Screen deneyimini
bitirmez: browser GUI, explorer/COM dolaylı başlatmalar,
full viewer entegrasyonu, fiziki mouse/focus yokluğu
ve farklı agent süreçleri arası lock hâlâ #402 kapsamındadır.
Üretim ortamına geçiş için #271 kabulü ve sahip onayı gerekir.
