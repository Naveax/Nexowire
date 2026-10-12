# Nexowire | AI komutları için merkezi özel ekran varsayılanı

Bir önceki aşamada her komutun ayrı ayrı
`ui_target:"private_desktop"` istemesi gerekiyordu.
Yeni kaynak değişikliği, test edilmiş ayrı Win32
masaüstünü **yapılandırılabilir varsayılan** yapar.

DEV / gözden geçirilmiş staging Agent çalışma ortamında:

```powershell
$env:NEXOWIRE_AI_UI_TARGET_DEFAULT = 'private_desktop'
```

Bu seçenek verildiğinde UI hedefi belirtilmemiş
`shell.exec`, `process.start`, `task.graph.run`,
`workspace.checks` ve Edge/Chrome
`browser.session.start` eylemleri Windows üzerinde
`NexowirePrivate` hedefine yönlendirilir.
`browser.session.start` için headless/visible tercihi
ayrıca devam eder. Görünür tarayıcı için özel hedef
zorunluluğu korunur.

Açıkça iletilen `ui_target` varsayılandan
önceliklidir. Yapılandırma eksikse eski headless
davranışı **değişmez**. Geçersiz konfigürasyon
hata üretir; Windows dışındaki makinelerde özel
masaüstü konfigürasyonu da fail-closed reddedilir.

`NexowirePrivate` içinde başlatılan işlemler
kullanıcının Windows `Default` input desktop'una
geçmez; fiziksel fare/odak eylemleri için
#408'deki ayrı yerel onay devam eder.

## Yaygın kullanım

Merkezi varsayılan sayesinde her AI isteminin
`ui_target` parametresini hatırlaması gerekmez.
Ancak bazı eski/üçüncü taraf betiklerin
`ShellExecute`, Explorer, COM veya Windows
UAC ile GUI işlemlerini başka masaüstüne
yönlendirmesi hâlâ mümkündür. Ortam
yapılandırması otomatik olarak mutlak
GUI izolasyonu sağlamaz.

Bu özellik şu anda **kaynak kodunda hazırdır**.
Üretim Agent servisine ortam değişkeni
eklenmemiş, cihaz ya da görev değiştirilmemiştir.
Mevcut yaşam döngüsü/restart ve oturum
güvenliği doğrulanmadan dağıtım yapılmaz.
P0 #271 korumalı kaynak ve #402 gerçek
odak/AI Screen kabulü açık kalır.

Runbook genel ayarı ayrı #409 üzerinden
ilerlemektedir; o PR merge edildikten
sonra merkezi default politikasına aynı
ilkenin uygulanması ayrıca doğrulanmalıdır.
