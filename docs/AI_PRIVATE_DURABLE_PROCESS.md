# Nexowire AI özel masaüstü | Kalıcı süreç oturumları

## Yeni process.start hedefi

`process_start` komutuna isteğe bağlı `ui_target: "private_desktop"`
eklenmiştir. Windows kullanıcı oturumu bulunduğunda, Nexowire'ın
`NexowirePrivate` Win32 masaüstünü **mevcut Default masaüstüne geçmeden**
başlatır ve bir Node process worker'ı doğrudan o masaüstüne bağlar.
Worker bu masaüstünde PowerShell/CMD komutunu başlatır. `process_read`,
`process_write` ve `process_stop` mevcut kontrol soketiyle çalışmaya
devam eder. Native agent yeniden bağlandıktan sonra kalıcı
oturuma tekrar bağlanılabilir.

Özel hedef kalıcı işçi altyapısını gerektirdiği için `durable:false`
gönderilse bile özel masaüstü oturumu kalıcı olarak çalıştırılır.
Yanıtlar `uiTarget: "private_desktop"`, `desktopName:
"NexowirePrivate"` metadatasını içerir. Bu bilgi oturum
kaydıyla birlikte korunur. Diğer sistemler için normal `headless`
varsayılanı değişmemiştir. Desteklenmeyen işletim sisteminde
aktif masaüstüne geri dönüş yapılmaz, işlem reddedilir.

## Worker başlatma

NexowirePrivate'a bağlı CreateProcess yardımcı işlevi stdin hattı
sunmadığından worker başlatma verisi süreç sahibinin yerel
`workerDir/init.json` dosyasına özel erişimle kaydedilir. Worker
dosyayı parse eder ve hemen siler. Shell child ortamına yalnızca
normal kullanıcı yolları/PATH gibi sınırlı değişkenler aktarılır;
agent token'ları ve `NODE_OPTIONS` aktarılmaz.

## Test sınırları

`NEXOWIRE_RUN_PRIVATE_PROCESS_LIVE=1` ile yapılan DEV Windows
testi doğrudan ayrı masaüstünde uzun süreli bir PowerShell sürecini
çalıştırır, stdin/stdout alışverişi yapar, ProcessManager
yeniden oluşturulduktan sonra tekrar bağlanır ve kullanıcı
masaüstünün hâlâ `Default` olduğunu doğrular. Test oluşturduğu
geçici özel masaüstünü kapatır.

Bu değişiklik **AI Screen'in tamamlanması değildir**.
`process.start` hedefinin çoklu uygulama ve Explorer üzerinden
dolaylı GUI başlatma davranışı, özel ekran viewer entegrasyonu,
UAC yönlendirmeleri ve tüm UI işlemlerinde fiziksel fare/
klavye/odak değişmezliği ayrı #402 kabul sürecidir.
Üretime yükleme için #271 güvenliği ve sahip onayı gerekir.
