# Nexowire AI Screen | Kompakt ekran ve özel uygulama listesi

Mevcut yerel Nexowire Private Viewer'a iki yeni
görsel özellik eklenmiştir.

- **COMPACT PREVIEW / EXPAND PREVIEW:** Yerel
  kullanıcı düğmeye tıkladığında izleyiciyi
  yaklaşık 480 × 350 boyutunda küçük izlemeye
  geçirir veya tam boyuta döndürür. Kompakt
  görünümde özel masaüstüne fiziksel geçiş
  düğmesi gizlenir, yalnızca görüntü önizlemesi
  ve genişletme/kapatma kalır.
- **Özel uygulama pencereleri:** İzleyicinin
  sağ tarafındaki liste, yalnızca
  `windows.private_desktop.windows` tarafından
  görülen `NexowirePrivate` Win32 masaüstünün
  görünür ve başlıklı ilk 24 penceresini
  başlık/PID ile gösterir. Kullanıcının aktif
  `Default` masaüstü pencereleri bu listede
  aranmaz, enumerate edilmez.

Windows masaüstü pencerelerinin salt-okunur
envanteri sınırlı JSON dosyasına yazılır.
WPF izleyicisi bu dosyayı canlı görüntü
güncellemeleriyle birlikte yeniler; bozuk
envanter görüntü akışını durdurmaz.
Kompakt açma, görevli pencereyi yeniden
odaklama, fiziksel imleç hareketi veya
Windows input desktop geçişi yapmaz.
İzleyici başlangıcında
`ShowActivated=false` korunmuştur.
**ENTER PRIVATE DESKTOP** yalnız tam
görünümde ve yerel tıklama ile kullanılabilir.

Windows DEV canlı kabulünde izleyici
başlatıldı, pencereler envanteri oluşturuldu,
izleyici HWND değişimi yapmadı ve
`inputDesktop=Default` kaldı.
Kaynak/tip/test doğrulamaları tamamlandı.

Bu özellikler hâlâ tam cihaz düzeyi ikinci
ekran oluşturmaz. Win+Tab sanal masaüstüne
entegrasyon, uygulama bazlı AI pencere
seçimi/işlem durdurma, video kare akışı,
çoklu oturum/monitor DPI ve uzun süreli
fiziksel odak kabulü #402 kapsamında kalır.
Üretim geçişi için P0 #271 ve sahip
onayı gerekir.
