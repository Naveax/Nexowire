# Nexowire AI Screen | WSLg görünür masaüstüne kaçışının engellenmesi

WSL'nin `wsl.exe` giriş sürecine `windowsHide:true`
uygulamak, Linux uygulamalarının WSLg/Explorer
aracılığıyla Windows kullanıcısının etkin
`Default` masaüstüne görünür pencere
açmasını kesin olarak engellemez.

Bu nedenle `wsl.exec` girişine isteğe bağlı
`ui_target:headless|private_desktop` eklenmiştir.

- AI için `NEXOWIRE_AI_UI_TARGET_DEFAULT=private_desktop`
  seçiliyse ve `wsl.exec` isteği açık `ui_target`
  belirtmiyorsa, işlem WSL başlatılmadan
  `WSL_PRIVATE_GUI_NOT_ISOLATED` hatasıyla
  reddedilir.
- Açıkça `ui_target:private_desktop` de
  aynı şekilde reddedilir. Gerçekte güvenli
  olmayan özel masaüstü desteği **varmış gibi**
  davranılmaz.
- Kullanıcı/kontrol paneli özel olarak
  `ui_target:headless` seçerse standart WSL
  CLI akışı korunur. Bu seçim WSLg grafik
  uygulamalarını veya başka bir GUI broker
  yolunu fiziksel `Default` ekranından
  izole edeceği anlamına gelmez.
- Ayar yoksa önceki `headless` varsayılanı
  ve mevcut WSL komutları değişmeden çalışır.

Güncellenen MCP v1 giriş şeması geriye uyumludur.
Windows DEV testleri özel AI modundaki
`wsl.exec` girişinin Windows/WSL subprocess
başlatılmadan reddedildiğini, açık headless
uyumluluğunu ve sözleşme eklemesini doğrular.
Odaklı testler ve TypeScript/derleme
kontrolleri başarılıdır.

İzolasyon sağlayan ayrı WSLg compositor
entegrasyonu doğrulanmadığı için özel modda
WSLg kullanımı desteklenmez. Üretim
güvenliği #271, UI kabulü #402 açık.
