# Nexowire AI özel masaüstü | Görünür Edge/Chrome

`browser_session_start` artık isteğe bağlı
`ui_target: "private_desktop"` desteğine sahiptir.
Windows'ta görünür (`headless:false`) bir Edge/Chrome
oturumu açılmak isteniyorsa bu hedef **zorunludur**;
aksi halde `BROWSER_VISIBLE_DEFAULT_DENIED` döner.
Böylece ajan varsayılan kullanıcı `Default` masaüstüne
görünür tarayıcı açıp pencere odağı çalmaya çalışmaz.
Mevcut `headless:true` CDP/DevTools akışı varsayılan
olarak devam eder.

Özel hedef seçildiğinde NexowirePrivate masaüstü açılır;
Chrome/Edge'in ayrı profil dizini, CDP loopback portu
ve pencere ölçüleri korunur. Tarayıcı, özel masaüstüne
bağlı native CreateProcess ile başlatılır. `browser_session_list`
içinde `uiTarget: "private_desktop"` ve
`desktopName: "NexowirePrivate"` görünür.
`browser_session_stop`, özel tarayıcı PID'sinin
Windows süreç ağacını durdurur ve oturum profilini temizler.

## DEV kabulü

Gerçek Windows DEV makinesinde görünür Edge penceresi
özel masaüstünde başlatıldı, CDP portu bulundu,
`about:blank` sayfası listelendi, input desktop
`Default` olarak kaldı ve tarayıcı durduruldu.
Görünür normal masaüstüne açık istek reddedildi.
Normal CI'de görünür GUI başlatma testi opsiyonel,
`NEXOWIRE_RUN_PRIVATE_BROWSER_LIVE=1` ile yürütülür.

## Devam eden sınırlar

Win32 private desktop ayrı fiziksel monitör/Win+Tab
sanal masaüstü değildir. Browser penceresinin AI
ekranında canlı küçük resim olarak izlenmesi, farklı
uygulama başlatma yolları, çoklu kullanıcı oturumu,
Explorer/COM yönlendirmeleri, Windows UAC izin
onayı ve fiziki fare/odak değişmezliğinin uzun
süreli kabulü #402'de tamamlanmalıdır.
Bu yalnızca kaynak kodudur; üretim ortamı #271
güvenlik kabulü ve kullanıcı onayı olmadan değiştirilmez.
