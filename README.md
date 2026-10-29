# Nexowire

**Bilgisayarını ChatGPT’ye bağla.** Dosyalar, terminal, tarayıcı ve desteklenen Windows işlemleri için kendi bilgisayarında çalışan Nexowire Agent kullanılır.

## İlk kez kuruyorsan buradan başla

**Windows 10/11, 64 bit (x64).** Önceden Nexowire, Node.js, npm, Git, Python veya PowerShell 7 kurulu olması gerekmez. Normal kurulum için yönetici olarak çalıştırman gerekmez. İnternet, bir GitHub hesabı ve ChatGPT hesabı yeterlidir; ChatGPT hesabında eklenti/özel MCP bağlantısı ekleme seçeneği bulunmalıdır.

### 1. İndir ve aç

**[Nexowire-Setup.cmd dosyasını indir](installers/Nexowire-Setup.cmd?raw=true)**, ardından indirilen dosyaya çift tıkla.

Bu depodaki kurucu, yayımlanmış **v1.0.7** uygulama paketini indirir. Türkçe
karakter içeren kullanıcı yolları için kısayol oluşturma düzeltmesi içerir;
yeni bir uygulama yayını veya imzalı installer değildir. [Dosyanın kaynağı ve doğrulaması](installers/README.md).

- GitHub’daki **Code → Download ZIP** düğmesi kurulum paketi değildir.
- Dosyanın adı `Nexowire-Setup.cmd` olmalı; `Nexowire-Setup.cmd.txt` olmamalı.
- Kurulum kendi Node.js çalıştırıcısını indirilen paketin içinden kullanır. Terminalde `npm install` çalıştırma.
- Windows dosyayı engellerse yayının kaynağını kontrol et. Kurumsal güvenlik politikasını veya antivirüsü kapatma. [Ayrıntılı yardım](docs/INSTALL_WINDOWS.md#sorun-yaşarsan).

[Resmî yayınlar ve önceki kurulum dosyası](https://github.com/Naveax/Nexowire/releases/latest).

### 2. Bilgisayarı hesabına bağla

Kurulumun açtığı tarayıcıda kendi GitHub hesabınla giriş yap ve **BAĞLA** düğmesine bas. İndirdiğin dosyayı, bağlamak istediğin bilgisayarda açmalısın.

[Kontrol paneline dön](https://nexowire-control-plane.nexowire-naveax.workers.dev/) ve cihazının **çevrimiçi** göründüğünü kontrol et. Sonradan bağlantı ekranını açmak için Başlat menüsünde **Nexowire** ara.

> Kurulum penceresinin kapanması veya bir Windows görevinin `Running` olması tek başına bağlantı kanıtı değildir. Cihazın panelde çevrimiçi görünmesi ve aşağıdaki ChatGPT kontrolünün çalışması gerekir.

### 3. ChatGPT’ye Nexowire’ı ekle

Bu adım ilk kurulumda bir kez yapılır. Bilgisayarın panele eklenmesi, ChatGPT hesabına eklentiyi kendiliğinden yüklemez.

1. ChatGPT’de **Eklentiler / Plugins → + → Özel MCP sunucusu ekle / Add custom MCP server** yolunu aç.
2. Adı **Nexowire**, kimlik doğrulamayı **OAuth** seç. **Sunucu URL’sine giriş panelinin adresini yapıştırma.** [Nexowire bağlantı sayfasındaki ChatGPT bölümünü](https://nexowire-control-plane.nexowire-naveax.workers.dev/connect.html#chatgpt) kullan. Bölüm henüz görünmüyorsa [elle adresi bulma adımı](docs/INSTALL_WINDOWS.md#chatgpt-adresini-bulma) aynı işi yapar.
3. Eklentiyi oluştur, yükle ve bağlantı ekranında cihazını bağladığın **aynı GitHub hesabıyla** giriş yap.
4. Yeni bir sohbet açıp `@Nexowire` seç. Aşağıdaki kontrol mesajını gönder.

OpenAI API anahtarı, Nexowire cihaz anahtarı veya yönetici parolası yapıştırman gerekmez. Eklenti ekleme seçeneği görünmüyorsa [ChatGPT’nin güncel bağlantı kılavuzunu](https://developers.openai.com/api/docs/guides/custom-mcp-server) ve hesabının/çalışma alanının izinlerini kontrol et.

```text
Nexowire ile cihazlarımı listele. Yeni kurduğum bilgisayarın adını ve çevrimiçi
olup olmadığını göster. Hangi bilgisayarı kullanacağımı seçtikten sonra yalnız
sağlık ve makine bilgisi kontrollerini yap; henüz dosya veya sistem değiştirme.
```

**Bitti sayılması için:** eklenti bağlı olmalı, kendi cihazın listelenmeli ve seçtiğin cihazda sağlık kontrolü başarılı olmalı. Agent bağlantısı ile CORE/yönetici yetkisinin durumu ayrı değerlendirilir.

## ChatGPT kurulumda bana yol göstersin

[Nexowire için hazır kurulum mesajını aç](docs/CHATGPT_INSTALL_PROMPT.md) ve yeni bir ChatGPT sohbetine yapıştır. Mesaj, eklenti veya yerel bilgisayar erişimi bulunmayan bir sohbette de adım adım yol gösterir; olmayan erişimi varmış gibi kabul etmez.

**[Ekran adlarıyla ayrıntılı Windows ve ChatGPT kurulum adımları](docs/INSTALL_WINDOWS.md)** · [Sorun giderme](docs/INSTALL_WINDOWS.md#sorun-yaşarsan)

## Sık sorulanlar

| Soru | Yanıt |
| --- | --- |
| Başka birinin GitHub hesabını mı kullanacağım? | Hayır. Cihazı ve ChatGPT bağlantısını kendi hesabınla kur. |
| Node.js, Git, npm, Tailscale veya sunucu kuracak mıyım? | Windows son kullanıcı yolu için hayır. Çalıştırıcı paketle gelir; mevcut barındırılan hizmet kullanılır. |
| İndirdikten sonra ne çalıştıracağım? | Yukarıdaki `Nexowire-Setup.cmd`. Kaynak kod ZIP’i, `.tgz` veya ayrı Broker yardımcı ZIP’i ilk kurulum değildir. |
| Eklenti var ama cihaz yok. | Önce bilgisayarda Agent kurulumu ve BAĞLA adımını tamamla; iki tarafta da aynı GitHub hesabını kullan. |
| Bilgisayar panelde var ama ChatGPT erişemiyor. | Eklentiyi ayrıca bağla, yeni sohbette seç ve doğru cihazı belirt. |
| macOS / Linux için aynı dosya çalışır mı? | Hayır. Bu kolay kurulum Windows x64 içindir. Diğer platformlar için [geliştirici/self-host kılavuzunu](docs/SELF_HOST.md) kullan; Windows `connect` akışıyla otomatik eşleme vaat edilmez. |

## Geliştiriciler ve kendi sunucusunu kuranlar

Normal kullanıcı yukarıdaki adımlarla başlar. Kaynak kod geliştirmek veya kendi Hub’ını barındırmak ayrı bir yoldur:

```bash
npm ci
npm run check
npm run build
```

[Self-host](docs/SELF_HOST.md) · [Mimari](docs/ARCHITECTURE.md) · [Ürün ve OAuth](docs/PRODUCT_CONTROL_PLANE.md) · [Dağıtım](cloudflare/README.md) · [Sürümler](docs/RELEASE.md) · [Yol haritası](ROADMAP.md)

Nexowire çalışma zamanında Remote Desktop Commander, SentinelX veya Codex kurulumu gerektirmez. ChatGPT → Nexowire MCP/Hub → Nexowire Native Agent yolu kullanılır. MCP v1 uyumluluğu `nexowire_surface_info` ile okunur; [sözleşme](docs/MCP_SURFACE.md) ayrı sürümlenir.

**Kullanım politikası:** barındırılan hizmetin geçerli Free-only politikası [burada](docs/FREE_ONLY_POLICY.md). [Scale v2 planı](docs/SCALE_V2_ROADMAP.md) geliştirme planıdır; yayımlanmış özelliğin veya kullanıcı hakkının kanıtı değildir.

**Güvenlik:** geliştirme sunucusunu internete açma. Token/anahtarları README, sohbet, ekran görüntüsü veya kaynak koduna koyma. OAuth, cihaz seçimi, Windows izinleri ve gerçek yürütme doğrulaması korunur. Geliştirme dalındaki test veya UI durumu üretimde CORE yetkisi oluşturmaz.
