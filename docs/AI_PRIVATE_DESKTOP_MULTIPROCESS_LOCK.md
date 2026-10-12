# NexowirePrivate | Çoklu Agent Süreci Kilidi

Önceki `serializePrivateDesktopLifecycle` yalnız aynı Node
process içindeki ardışık istekleri koruyordu. İki farklı
Node native-agent süreci aynı Windows kullanıcı profilindeki
`NexowirePrivate` masaüstüne aynı anda `start`, `launch`
veya `stop` gönderirse, ortak `state.json`, geçici
dosyalar veya `launchedPids` kayıtları yarışabiliyordu.
Bu durum tekrar host başlatılması, kayıp PID kaydı
ve durdurmada açık kalan özel uygulamalara yol açabiliyordu.

## Çözüm

- Aynı kullanıcı ve özel masaüstü çalışma kökündeki
  `.lifecycle.lock` dizini `mkdir` atomik
  oluşturulmasıyla **farklı agent process'leri arasında**
  karşılıklı dışlama uygular.
- `owner.json` içinde PID, oluşturma zamanı ve her
  kilit için rastgele nonce vardır. İş tamamlandığında
  yalnız nonce/PID eşleşen sahibi kilidi kaldırır.
- Agent çökerse ve sahip PID artık yaşamıyorsa, en az
  30 saniye bekledikten sonra atomik ikinci
  `.lifecycle.lock.recovery` dizini kullanılarak
  eski kilit temizlenir. Canlı veya izin nedeniyle
  durumu belirsiz PID kilidi hiçbir zaman zorla
  silinmez.
- Kilit alımı **40 saniye** içinde tamamlanmazsa
  `PRIVATE_DESKTOP_LIFECYCLE_LOCK_BUSY` verir.
  Kullanıcının görünür masaüstünde iş başlatmaya
  geri dönmez ve fiziksel imleci kullanmaz.
- Var olan aynı-process sıralaması korunur;
  yeni cross-process kilit yalnız
  `windows.private_desktop.start/stop/launch`
  komutlarını kapsar.

## Kabul

Windows DEV makinesinde iki ayrı Node PID'siyle
ortak kilide erişim testi, aynı process hata sonrası
sıralama, canlı PID kilidinin korunması ve kapanmış
PID'nin kontrollü kurtarılması başarıyla yürütüldü.
Mevcut ayrı Windows masaüstünü başlatma, sanal
fare/klavye ve inputDesktop=Default canlı testleri
de başarılı.

## Sınırlar

Kilidin güvenli olması, GUI uygulamalarının
Windows ShellExecute/Explorer/COM üzerinden
başka masaüstüne pencere taşıyamayacağı anlamına
gelmez. Başka çalışma kökü kullanan iki agent
aynı kilidi paylaşmaz. PID yeniden kullanımı
nedeniyle ölü kilit yanlışlıkla canlı sanılırsa
otomatik kaldırılmayabilir; fail-closed timeout
oluşur. Bu kaynak kodudur; üretim P0 #271
ve AI Screen #402 kabulü devam eder.
