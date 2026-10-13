# Nexowire AI Screen | Gerçek tam ekran görüntüleyici

Mevcut Windows Private Viewer'ın kompakt (480×350) ve normal (1280×820) önizlemesine yerel kullanıcı tarafından tıklanabilen **FULL SCREEN / EXIT FULL SCREEN** düğmesi eklenmiştir.

- Tam ekrana geçiş açık yerel tıklama ile olur. İlk açılışın `Window.ShowActivated=false` varsayılanı korunur, otomatik tam ekran veya otomatik pencere odağı istenmez.
- `WindowStyle=None`, `ResizeMode=NoResize` ve `WindowState=Maximized` ile mevcut fiziksel monitörde AI masaüstünün **izleyici penceresi** tam ekrana geçer. Bu bir Win+Tab sanal masaüstü veya fiziksel ikinci ekran değildir.
- Başlangıçta kompakt görünüm varsa tam ekran isteği önce standart genişletilmiş pencereye döner, ardından tam ekrana geçer.
- Tam ekranda yanlışlıkla Windows giriş masaüstünü değiştirebilen `ENTER PRIVATE DESKTOP` düğmesi gizlenir; acil durdurma ve izleyiciyi kapatma düğmeleri görünür kalır.
- Çıkışta normal pencere stili, boyutları, uygulama listesi ve kompakt önizleme erişimi geri gelir.
- `SwitchDesktop`, `SetForegroundWindow`, `SetCursorPos` ve fiziksel klavye/fare enjeksiyonu bu akışta kullanılmaz.

DEV'de kaynak bağlama doğrulaması, mevcut WPF izleyicisinin gerçek Windows'ta açılış/çalışma/kapanış kontrolü, foreground HWND ve inputDesktop=Default kontrolleri **4/4 PASS**; TypeScript ve build PASS.

Bu test **tam ekran düğmesine gerçek fiziksel tıklamayı** otomatikleştirmemiştir. Uzun kullanıcı oturumu UX kabulü ve tüm GUI yollarında izolasyon #402'de devam eder. Üretim görevleri/ACL/Hub/Broker/Agent değiştirilmemiştir; #271 güvenlik üzerinde çalışma yapılmamıştır.
