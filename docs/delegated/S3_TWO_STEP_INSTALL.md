# S3-01 — Windows: iki adımda kurulum

> 31 Ekim 2026 · Yardımcı 2 · source-only / documentation. Kaynak snapshot: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main). Canlı durum ve fiziksel kabul doğrulanmadı.

Windows 10/11 x64, internet ve GitHub hesabı içindir. Normal akış yönetici, VPN, API anahtarı, Node/npm/Git veya PowerShell 7 kurulumu istemez. Bu kılavuz uygulamayı çalıştırmaz.

## 1. İndir ve kur

[Depodaki Nexowire-Setup.cmd](../../installers/Nexowire-Setup.cmd?raw=true) dosyasını indir (gerekirse Download raw). `.cmd.txt`, kaynak Download ZIP, `.tgz` veya Broker ZIP'i kullanma. Dosyaya normal çift tıkla; penceredeki sonucu bekle. Başlat menüsünde Nexowire oluşur; uygulama `%LOCALAPPDATA%\Nexowire\versions\...` altındadır. Engellenirse kaynak ve hata metnini kontrol et; korumaları kapatma.

**Sürümü karıştırma:** Bu snapshot'taki README, INSTALL_WINDOWS ve bootstrap açıkça v1.0.7 ZIP'ine sabitlidir (`NX_VERSION=1.0.7`, payload SHA-256 `1d463f408d9f18840748c2e83080adfa3f642afadefd000f8c43cadae5e20896`). Buna karşılık GitHub latest release API, **v1.0.8'in 30 Ekim 2026 15:55:53 UTC'de yayımlandığını** bildiriyor. Son yayının Setup ve Windows ZIP dosyaları mevcut; bu çalışma onların içeriğini indirip çalıştırmadı. Repo bootstrap'ını kullanmak v1.0.8 kurduğunu kanıtlamaz. Hangi sürümün tavsiye edileceği için ana ekip bu ayrımı netleştirmelidir; farklı sürümün checksum'unu kullanma.

## 2. GitHub ile giriş yap ve BAĞLA

Kurulumun açtığı tarayıcıda kendi GitHub hesabınla giriş yap. Bilgisayar adını kontrol edip **BAĞLA**'ya bas. Sonra resmî panelde doğru cihazın çevrimiçi göründüğünü kontrol et. Sayfa açılmazsa Başlat → Nexowire ile aç; ikinci kaynak Agent başlatma. Eşleme süresi dolmuşsa yeni sayfa kullan. Parola/OAuth kodu paylaşma.

Pencerenin kapanması, kısayol veya görevde Running tek başına bağlantı kanıtı değildir. Normal bağlantı CORE/yönetici yetkisi kabulü değildir.

## Ayrı işlem: ChatGPT bağlantısı

Bilgisayarını bağlamak eklenti kurmaz. [Ana kılavuzdaki ChatGPT adımı](../INSTALL_WINDOWS.md#4-chatgpt-bağlantısını-kur) üzerinden hesabının sunduğu özel MCP/eklenti ekleme ekranını kullan; ad Nexowire, auth OAuth, sunucu Nexowire'ın sağladığı **tam resource adresi** olmalı. Panel adresine `/mcp` ekleyerek tahmin etme. Aynı GitHub hesabıyla bağlan. Seçenek hesabında yoksa çalışma alanı iznini ve kılavuzun resmi OpenAI bağlantısını kontrol et; Windows'u yeniden kurmak özelliği açmaz. Menü isimlerinin güncel ChatGPT UI'da burada ayrıca doğrulandığı iddia edilmez.

Eklenti zaten varsa tekrar oluşturma. Yeni sohbette seçip yalnız cihaz listesi ve seçilen doğru cihazda sağlık/makine bilgisi iste. Bu yönergedeki kontroller kullanıcı tarafından yapılacak adımlardır; burada çalıştırılmadı.

## Doğrulama ve gelecek hedef

| Kanıt | Durum |
|---|---|
| Repo README/INSTALL_WINDOWS/installers README ve CMD | Snapshot'ta okunarak v1.0.7 pin tutarlılığı doğrulandı |
| [v1.0.8 yayını](https://github.com/Naveax/Nexowire/releases/tag/v1.0.8) | Release API metadata'sı doğrulandı; cihazda kurulu olduğu bilinmiyor |
| v1.0.8 Windows ZIP digest (API) | `ac653bc0d30bcd1a6ce8a46bf7e96f1863b34bb5855d16f15bf39de926486125`; yerel dosya hash'i ölçülmedi |
| İmzalı installer hedefi | Gelecek hedef; hash, bağımsız Nexowire yayıncı imzası değildir |
| Gerçek OAuth, kurulum, fiziksel cihaz | Çalıştırılmadı / UNKNOWN |

Kaynaklar: [README](../../README.md), [INSTALL_WINDOWS](../INSTALL_WINDOWS.md), [installers README](../../installers/README.md), [latest release API](https://api.github.com/repos/Naveax/Nexowire/releases/latest). Kaynak belgelerinin değişmesi halinde sürüm seçimini yeniden incele.
