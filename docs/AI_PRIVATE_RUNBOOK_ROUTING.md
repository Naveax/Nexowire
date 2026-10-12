# AI Screen | Runbook görevlerinin ayrı masaüstünde çalışması

`runbook_run(ui_target: "private_desktop")` desteklenir.
Bu seçim yalnız tek bir komutu değil, runbook içinde
bağımlılıklara göre çalışan **bütün task_graph adımlarını**
`NexowirePrivate` Win32 masaüstüne bağlar.

Runbook üst düzey `private_desktop` hedefi belirlediğinde
iç task_graph özel bir `ui_target:"headless"` yazmış
olsa bile bu değer güvenli özel hedefle değiştirilir.
Ayrı masaüstü yoksa kullanıcı `Default` ekranına
sessiz geri dönüş yapılmaz; adım hata verir.
Assertion adımları mevcut salt-okunur davranışını korur.

Görev yeniden başlatma sırasında özel hedefi
korumak için runbook spec hash'e `ui_target`
eklenmiştir. Bu ekleme yalnız `private_desktop`
modunda yapılır: eski headless runbook hash'leri
değişmez. Hedefi değiştirerek `resume` yapma
denemesi `RUNBOOK_SPEC_MISMATCH` ile reddedilir.
Çıktı `uiTarget` ve `desktopName` metadata taşır.

Windows DEV canlı testinde iki bağımlı PowerShell
task_graph adımı çalıştırıldı, doğru çıktılar
doğrulandı ve `inputDesktop=Default`
kaldığı kontrol edildi. Mock testler de tehlikeli
alt görev override'larının reddedildiğini ve eski
hash'in değişmediğini doğrular.

Bu kod değişikliği tam AI Screen, ikinci monitör
veya tüm GUI/Explorer üzerinden dolaylı başlatmaları
izole etme iddiası taşımaz. Üretim P0 #271
ve GUI UX #402 kabul süreci açık kalır.
