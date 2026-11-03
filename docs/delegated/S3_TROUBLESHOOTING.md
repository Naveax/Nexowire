# S3-02 — Güvenli sorun giderme

> 31 Ekim 2026 · Yardımcı 2 · source-only / documentation. Kaynak snapshot: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main). Canlı durum ve fiziksel kabul doğrulanmadı.

Önce takılan aşamayı ayır: **indirme → kurulum → GitHub/BAĞLA → panel çevrimiçi → ChatGPT eklentisi → araç sonucu**. Bir aşamanın tamamlanması sonrakini kanıtlamaz. Aşağıdakiler tanı planıdır; otomatik recovery komutu içermez.

| Belirti / karar | Salt-okunur kontrol ve güvenli sonraki adım | Dur / destek sınırı |
|---|---|---|
| İndirilemiyor | Resmî GitHub URL, tarayıcı indirme hata metni, internet ve disk boşluğunu kontrol et | Proxy/kurum politikasını aşma; ağ sorumlusuna hata metni |
| Kaynak ZIP / .cmd.txt | Dosya adı ve uzantısını kontrol et, resmi raw CMD'yi indir | Kaynak kodu veya Broker'ı kurulum sanma |
| Bütünlük / checksum mismatch | Dosyanın sürümüne ait SHA256SUMS ile karşılaştır; kaynağı kontrol edip eksik indirmeyi yeniden indir | Hash kontrolünü kaldırma; farklı sürüm hash'i kullanma |
| SmartScreen | Kaynak/yayın sürümü ve uyarı metnini kontrol et | İmza varmış gibi onaylama, korumayı/politikayı kapatma; yayıncıya ilet |
| Kurulum bitti ama offline | PC açık mı, internet var mı, panel doğru hesabı mı gösteriyor? Başlat → Nexowire yolunu kullan | Kısayol/Running başarı değildir; DB/anchor silme, ikinci Agent açma |
| Yanlış GitHub hesabı | Panel ve ChatGPT bağlantısında görünen hesabı karşılaştır; doğru hesapla normal yeniden giriş | Kimlik/cihaz kaydını değiştirerek kota sıfırlama deneme |
| Eklenti yok | ChatGPT hesabı/çalışma alanı izinleri ve ana kılavuzun güncel resmi bağlantısı | Windows'u tekrar kurma; API anahtarı uydurma |
| OAuth yarım kaldı | Hangi ekranda kesildiğini ve süre doldu mesajını kaydet; normal giriş akışını yeniden aç | Eski kodu yeniden gönderme, cookie/token paylaşma |
| Eşleme süresi doldu | Başlat → Nexowire ile yeni istek/sayfa; adı doğrula ve BAĞLA | Eski sayfayı tekrar tekrar onaylama |
| Tekrar cihaz görünüyor | Hesap, görünen ad ve online durumunu karşılaştır; hassas ID'leri gizleyerek destek iste | Alias'ı kimlik sayma; kaydı/anchor'ı kendin silme |
| Proxy / TLS inspection | Tarayıcıda resmî GitHub ve panel erişim hata metni, kurum proxy gereksinimi | Sertifika doğrulamasını kapatma, ağ ayarını değiştirme; IT'ye ilet |
| Antivirüs engeli | Karantina/engelleme uyarısının dosya ve zamanını oku | Antivirüsü kapatma veya genel istisna ekleme; yayıncı/IT incelemesi |
| Düşük disk | Windows Depolama ekranında boşluğu oku, hata metnini kaydet | Nexowire journal/WAL/SHM veya kullanıcı verisini silme |
| Yeniden giriş gerekli | Normal hesap arayüzünden doğru hesapla giriş yap, yeni sohbet/eklenti seçimini kontrol et | Tokenları elle düzenleme veya auth'suz moda geçme |
| 401 | Giriş süresi / hesap / hangi endpoint aşaması olduğunu kontrol et; normal yeniden giriş | Bunun kesin token expiry olduğunu varsayma; başarısız mutation'ı tekrar yürütme |
| 403 / 1010 | Adres, hesap, izin ve ağ engelini ayır; tam hata kodunu kaydet | Node kurmak veya DB silmek yetki engelini çözmez |
| 409 | Duplicate/replay veya başka conflict olabilir; tam hata kodunu oku | MCP_DUPLICATE_REQUEST ikinci yürütme değildir; yeni ID ile mutation tekrarına geçme |
| 5xx | Zaman, endpoint aşaması ve hata kodunu kaydet; servis desteğine ilet | Yanıt kaybı başarı/başarısızlık kanıtı değildir; mutation UNKNOWN kalır |
| LOCAL_ENROLLMENT_REQUIRED | Ayrı CORE yerel yetki durumu olarak raporla | Kurulum sıfırlama, sahte onay, yönetici komutları ile aşma |
| SQLite WAL / mutation dispatch denied | Hata metnini koruyup ana ekibe aktar | WAL/SHM/DB veya UNKNOWN kayıtlarını silme/onarım çalıştırma |

**Mutation sonrası timeout/kayıp ACK:** Etki olup olmadığı bilinmiyorsa yeniden çalıştırma. `unknown` terminal durumunun çözümü yetkili kanıt gerektirir. Transport başarısı komut başarısı değildir.

Destek paketi: Windows sürüm/mimari, indirilen yayın ve dosya adı, aşama, zaman, gizlenmiş hata kodu. Parola, cookie, Authorization header, OAuth kodu, cihaz anahtarı, kişisel yol veya tüm `.nexowire` klasörünü paylaşma.

Kaynak: [INSTALL_WINDOWS sorun tablosu](../INSTALL_WINDOWS.md#sorun-yaşarsan), [README](../../README.md), [Free-only duplicate sözleşmesi](../FREE_ONLY_POLICY.md), [quota/cost reservation lifecycle](../SCALE_V2_QUOTA_AND_COST.md). HTTP sınıfları tanı yönlendirmesidir; her 409 veya 5xx için kesin Nexowire nedeni iddia edilmez.
