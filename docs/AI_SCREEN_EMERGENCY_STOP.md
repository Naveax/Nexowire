# AI Screen: yerel acil durdurma

Nexowire Private Viewer'ın araç çubuğuna **STOP AI WORKSPACE** düğmesi eklendi.

**Ne yapar:** Kullanıcı yerel WPF görüntüleyicide düğmeye tıklar ve Windows onay kutusunda **Yes** seçerse, istek görüntüleyicinin özel çalışma dizinindeki `emergency-stop.request` dosyasına yazılır. Çalışan Native Agent yenileme döngüsü bu isteği işler; Windows giriş masaüstünün `Default` olduğunu salt-okunur doğrular ve yalnızca `windows.private_desktop.stop` tarafından takip edilen ayrı masaüstü host, shell ve özel uygulama PID'lerini durdurur. Ardından AI görüntüleyicisini kapatır ve çalışma dosyalarını temizler.

**Ne yapmaz:** Fiziksel fare/klavyeyi hareket ettirmez, `SwitchDesktop` çağırmaz, kullanıcının `Default` masaüstündeki uygulamalarını kapatmaz, Agent/Hub/Broker/ROOT/CORE ya da Windows görevlerini durdurmaz. Bu bir Windows yönetici yetkisi verme yolu değildir.

**Reddetme:** Windows giriş masaüstü `Default` değilse, görünür oturumun kararmasını önlemek için istek reddedilir ve görüntüleyicide açıklama gösterilir. Başka bir hata oluşursa istek tamamlanmış sayılmaz; hata görüntüleyicide görünür. Bağımsız özel masaüstü güvenli şekilde kapatılamıyorsa servisi, diski veya başka PID'leri keyfi öldürerek devam edilmez.

**Canlı DEV kabulü:** Ayrı geçici Windows DEV runtime kökünde görüntüleyici ve NexowirePrivate başlatıldı, yerel WPF tıklamasının ürettiği IPC komutu eşdeğer test girdisiyle iletildi. 7 saniyelik canlı çalışmada yalnızca özel masaüstü ve görüntüleyicinin durduğu ve `inputDesktop=Default` kaldığı doğrulandı. Düğmeye fiziksel tıklama testi otomatik testte simüle edilmedi. Toplam hedefli test **4/4 PASS**, typecheck ve build PASS.

**Henüz kalanlar:** Tüm özel AI oturumlarının envanteri, gerçek fiziksel UI tıklama kabulü, uzun süreli ön plan/odak stres testi, Explorer/COM/UAC GUI yollarının güvenli yönetimi ve cihaz yönetim panelinin bütünleşik hali #402'de açıktır. #271 konusu ertelenmiştir; üretim cihazının ayrıcalıklı dosyalarına veya servislerine müdahale edilmedi.
