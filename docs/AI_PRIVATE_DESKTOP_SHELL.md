# Nexowire AI özel masaüstü | Komut yürütme

## Sorun

Windows üzerindeki olağan `shell.exec` çağrısı `windowsHide` ile kendi konsolunu
gizler, ancak çağrılan betik `Start-Process`, `explorer.exe` veya başka GUI
yolları kullanırsa kullanıcının `Default` masaüstünde pencere açılması ve
odak çalınması yine mümkündür. `windowsHide` bir Windows masaüstü izolasyonu
değildir. Bu nedenle daha önce uygulanan özel masaüstü, genel komut
çalıştırma yoluna otomatik bağlanmamıştı.

## Yeni açık seçim

`shell_exec` arayüzü Windows için `ui_target: "private_desktop"` seçeneğini
destekler. Bu mod, `NexowirePrivate` Win32 masaüstünü aktif ekranı
değiştirmeden başlatır; ayrı masaüstüne doğrudan CreateProcess ile
bağlanan bir Node worker üzerinden PowerShell/CMD komutunu çalıştırır.
Çıktı (stdout/stderr) ve sonlanma bilgisi bounded IPC dosyalarıyla
mevcut shell.exec yanıt sözleşmesine geri döner. Fiziksel imleci hareket
ettirmez; konsol masaüstünün ön plana alınmasını istemez. Varsayılan
`headless` modu geriye uyumluluk için şimdilik değişmedi.

GUI uygulamaları için zaten var olan
`windows.private_desktop.launch` doğrudan ayrı masaüstüne bağlı
CreateProcess yoludur; oradaki pencere/kayıtları
`windows.private_desktop.windows` ve özel viewer/screen aracılığıyla
görülür. Sistem konsolu üzerinde GUI başlatılması amaçlanmıyorsa
`shell_exec` için `private_desktop` seçilmelidir.

## Sınırlar

- Bu ilk dilim ayrı *Win32 masaüstü* kullanır. Windows `Win+Tab`
  sanal masaüstünde ikinci monitör gibi gösterim, bağımsız sanal ekran
  sürücüsü, her GUI uygulamasının `ShellExecute` yönlendirmesi ve
  tüm `process.start` yollarının zorunlu özel alana bağlanması henüz
  tamamlanmış değildir.
- Tek bir yerel `Start-Process` veya Explorer aracısı işletim sistemi
  üzerinden başka masaüstüne yönelmeye çalışabilir; bu API onun
  asla odak çalamayacağına ilişkin evrensel bir garanti değildir.
- Özel worker, ayrı masaüstünü kullanmak için **canlı kullanıcı Windows
  oturumu** gerektirir. Session 0 servisleri veya GUI erişimi olmayan
  makinelerde başarısız olabilir; bu durumda aktif masaüstüne sessiz
  geri dönüş yapılmaz.
- Worker sır/token değişkenlerini başka bir süreç ortamına taşımaz;
  yalnız normal kullanıcı dizini ve PATH için gereken sınırlı
  değişkenleri taşır. Geçici veri kullanıcıya özel dizinde kalır;
  beklenmeyen worker kopmasında forensik güvenlik için dosya otomatik
  silinmeyebilir.
- Canlı DEV testi `NEXOWIRE_RUN_PRIVATE_SHELL_LIVE=1`
  seçilerek ayrı çalıştırılır. Normal CI gizli masaüstü başlatmaz.

## Sonraki dilimler

Uygulama başlatıcılarını (GUI, terminal, browser), kalıcı process
oturumlarını ve AI iş akışlarını bu hedefe varsayılan olarak bağlamak;
güvenilir görüntü yakalama, canlı küçük izleme, sanal imleç ve
odak değişmezliğinin çoklu uygulama/yeniden başlatma testleri
tamamlanmadan üretime otomatik geçiş yapılmamalı.
