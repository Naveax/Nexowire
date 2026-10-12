# AI Screen | Odak çalmayan yerel izleyici

Özel Win32 masaüstünün canlı görüntüsünü gösteren mevcut
`windows.private_viewer.start` WPF penceresi daha önce
Windows masaüstünde normal etkinleştirilen bir pencere
olarak açılıyordu; çağrıyı yapan `powershell.exe`
konsolu da görünür olabiliyordu.

Bu değişiklik izleyicide `Window.ShowActivated = false`
kullanır. Böylece izleyici programatik olarak
kullanıcının aktif penceresini öne geçirmez.
Yeni işlem sabit `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
üzerinden, `shell:false` ve `windowsHide:true`
ile çalışır; konsol görüntüsü saklanır, WPF pencere
isteyen kullanıcı için erişilebilir kalır.
`Topmost` eskisi gibi varsayılan `false` durumundadır.

Yerel izleyicinin **ENTER PRIVATE DESKTOP**
düğmesi Windows giriş masaüstünü fiziksel olarak
değiştirebilir; ancak yalnızca **yerel kullanıcı
tıklarsa** çalışır. Normal viewer açılışı bunu
yapmaz. Kapatma düğmesi ve canlı ekran görüntüsü
akışı korunmuştur.

Windows DEV canlı kabulünde ayrı özel masaüstü
ve izleyici açılmış, Win32 `GetForegroundWindow()`
öncesi/sonrası HWND aynı kalmış ve
`inputDesktop=Default` doğrulanmıştır.

İzleyici hâlâ ayrı AI yönetim panelinin tümü
değildir. Uygulama envanteri, görev geçmişi,
mini viewer, sistem genelinde daha uzun süreli
odak stres testi, Explorer/COM kaynaklı
pencere açılmaları ve fiziksel input garantileri
#402 altında devam eder. Üretimde P0 #271
kabulü ve sahip onayı zorunludur.
