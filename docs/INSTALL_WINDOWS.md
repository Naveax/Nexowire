# İlk bilgisayarı Windows ve ChatGPT’ye bağlama

Bu kılavuz, bilgisayarında Nexowire, Node.js, Git, npm veya bir ChatGPT
eklentisi bulunmadığını varsayar. Kolay kurulum Windows 10/11 **x64** içindir.
Windows’un kendi PowerShell’i kullanılır; PowerShell 7 ayrıca kurulmaz.

Üç farklı durum vardır: **uygulama kurulu**, **cihaz hesabına bağlı** ve
**ChatGPT eklentisi bağlı**. Birinin tamamlanması diğerlerini otomatik olarak
tamamlamaz. Aşağıdaki sırayı takip et.

## 1. Kurulum dosyasını indir

**[Resmî v1.0.8 Nexowire-Setup.cmd indir](https://github.com/Naveax/Nexowire/releases/download/v1.0.8/Nexowire-Setup.cmd)**

Bu bağlantı GitHub'da yayımlanmış **v1.0.8** kurucusuna gider; kendisi
sürümüne sabitlenmiş `Nexowire-Windows-x64.zip` paketini SHA-256 ile doğrular.
Kurulumda gereken Node çalıştırıcısı ve uygulama bağımlılıkları pakettedir.
Boş bir PC’ye önce Node/npm kurman gerekmez.

Önceki `../installers/Nexowire-Setup.cmd` dosyası v1.0.7'ye sabitlenmiş,
denetlenebilir tarihsel arşivdir; **yeni kurulum için kullanma**.
[Arşiv kaynağı ve hash bilgisi](../installers/README.md).
Resmî v1.0.8 setup SHA-256:
`8f39a1954eb22131ed516d32acfad1fe17e3ccb9766eda3883b90595a9135694`.
Bu checksum, yayıncı imzası veya CORE fiziksel yetki kanıtı değildir.

GitHub **Code → Download ZIP** kaynak kodu indirir ve bu kurulumun yerine geçmez.
`nexowire-*.tgz` geliştirici paketidir. Ayrı Broker yardımcı ZIP’i ilk kurulum
paketi değildir. [Yayın sayfası](https://github.com/Naveax/Nexowire/releases/latest)
doğrulama dosyalarını da içerir. Paket hash kontrolü, Nexowire uygulamasının
bağımsız yayıncı imzası veya CORE güvenlik kabulüyle aynı şey değildir.

Dosya Gezgini’nde **Görünüm → Göster → Dosya adı uzantıları** seçeneğiyle gerçek
uzantıyı kontrol et. Dosyanın adı `Nexowire-Setup.cmd` olmalı;
`Nexowire-Setup.cmd.txt` bir komut dosyası değildir. Aynı dosya tekrar
indirildiyse Windows `(1)` ekleyebilir; dosya adını değiştirerek kaynağını
doğrulamış olmazsın. Kaynak/uzantı şüpheliyse resmî yayın bağlantısından tekrar
indir; başka bir kaynaktan gelen `.cmd` dosyasını çalıştırma.

İstersen indirdiğin kurucunun bütünlüğünü Windows PowerShell'de
`Get-FileHash` ile kontrol et. Dosya normal **İndirilenler** konumundaysa
şu salt-okunur komutu kullanabilirsin:

```powershell
Get-FileHash -LiteralPath (Join-Path $env:USERPROFILE 'Downloads\Nexowire-Setup.cmd') -Algorithm SHA256
```

Dosya başka yerdeyse komuttaki yolu kendi indirme konumunla değiştir.
Sonucu yukarıdaki resmî SHA-256 ile **tam** karşılaştır. Farklıysa
çalıştırma; bir hash eşleşmesi de tek başına yayıncı kimliğini kanıtlamaz.

**SmartScreen / kurumsal engel:** Windows uyarısı geldiğinde işlemi durdur.
Önce resmî GitHub yayınına gittiğini, dosyanın gerçek adını/uzantısını ve
yayınlanan SHA-256 bilgisini kontrol et. Dosyanın kaynağı doğrulanamıyorsa
çalıştırma. Kurum bilgisayarında BT/yönetici politikasını takip et;
SmartScreen'i, antivirüsü veya uygulama denetimini devre dışı bırakma.
`Yine de çalıştır` gibi güvenlik uyarısını atlayan adımlar otomatik çözüm
değildir. Uyarı metnini gizli bilgi içermeyecek biçimde kaydet.

## 2. İndirdiğin dosyayı aç

1. Tarayıcının **İndirilenler** listesinden `Nexowire-Setup.cmd` dosyasını aç.
2. Dosyaya normal çift tıkla. **Yönetici olarak çalıştır** seçmen gerekmez.
3. İndirme ve açma işlemi bitene kadar kurulum penceresini kapatma.
4. Tarayıcıda Nexowire bağlantı ekranının açılmasını bekle.

Uygulama `%LOCALAPPDATA%\Nexowire\versions\...` altına kurulur ve Başlat menüsüne
**Nexowire** kısayolu eklenir. Normal akış kullanıcıya Hub adresi, cihaz anahtarı,
komut satırı veya Tailscale kurulumu sormaz.

## 3. Cihazı kendi hesabına bağla

Tarayıcı giriş isterse kendi GitHub hesabınla giriş yap. GitHub hesabın yoksa
önce GitHub’ın kendi sitesinde hesap oluştur. Şifre veya doğrulama kodunu
ChatGPT’ye gönderme.

Nexowire ekranındaki bilgisayar adını kontrol et ve **BAĞLA** düğmesine bas.
Sonra [kontrol panelinde](https://nexowire-control-plane.nexowire-naveax.workers.dev/)
bu cihazın **çevrimiçi** göründüğünü kontrol et. Yeniden açmak gerekirse Başlat
menüsünden **Nexowire**’ı çalıştır; kaynak koddan ikinci bir Agent başlatma.

**BAĞLA görünmüyor veya çalışmıyorsa:** Genel indirme ekranı ve cihaz
eşleme onay ekranı farklıdır. BAĞLA yalnız kurucunun oluşturduğu eşleme
oturumunda cihaz adıyla görünür. `BAĞLANIYOR…` sırasında yeniden basma;
`TEKRAR DENE` görünürse yalnız o düğmeyi bir kez kullan. Hata devam ederse
metni not et, Başlat → Nexowire ile **yeni** eşleme oturumu aç ve yeni
tarayıcı ekranını kullan. Eski eşleme sekmesini, yerel uygulama klasörünü
veya cihaz kayıtlarını silme. `Bu hesap için cihaz limiti dolu` hatasında
tekrar tekrar denemek limiti kaldırmaz; hesap/cihaz limitini kontrol et.

### Cihaz başka GitHub hesabında görünüyorsa

Cihazı **BAĞLA** ile onayladığın GitHub hesabını kendi tarayıcı ekranında
kontrol et. ChatGPT'de Nexowire için OAuth girişinde **farklı bir GitHub
hesabı** kullanıldıysa cihaz listesi boş görünebilir. Cihazı yeniden kurma
veya mevcut cihazları silme. Bağlantı işlemini durdur, hangi hesapla giriş
yaptığını doğrula ve ChatGPT bağlantısını **cihazı bağladığın hesapla**
yeniden yetkilendirmeyi dene. Sohbete kullanıcı adı dışında hesap bilgisi,
cookie, OAuth kodu, oturum URL'si veya ekranın gizli kısmını gönderme.

Kurucu kapanmış olması, kısayol oluşması veya bir görevin `Running` görünmesi
cihaz bağlantısının sağlıklı olduğu anlamına gelmez.

## 4. ChatGPT bağlantısını kur

Eklentiyi bu hesabına önceden eklediysen aynı eklentiyi tekrar oluşturma;
bağlı hesabı kontrol et ve yeni sohbette seç.

İlk kez ekliyorsan [Nexowire bağlantı sayfasını](https://nexowire-control-plane.nexowire-naveax.workers.dev/connect.html#chatgpt)
aç. **ChatGPT’ye bağla** bölümünde verilen sunucu adresini kopyala. Bu bölüm
henüz yayımlanmamışsa aşağıdaki elle adres bulma yolu kullanılabilir.

ChatGPT’de **Eklentiler / Plugins** ekranını aç, **+ → Özel MCP sunucusu ekle /
Add custom MCP server** seç. Formdaki değerler:

| Alan | Değer |
| --- | --- |
| Ad | `Nexowire` |
| Sunucu URL’si / Server URL | Nexowire’ın verdiği **tam MCP adresi** |
| Kimlik doğrulama / Authentication | `OAuth` |

Eklentiyi oluşturup yükle. Bağlanırken cihazı eklediğin **aynı GitHub hesabını**
kullan. Nexowire’ın normal OAuth yolu otomatik istemci kaydı kullanır; kullanıcıya
cihaz anahtarı, OpenAI API anahtarı veya sabit istemci parolası verilmez.
Formun farklı bir kimlik bilgisi istemesi durumunda rastgele değer üretme veya
**No authentication** seçerek OAuth’u kaldırma.

Menü adları arayüz diline göre değişebilir. Eklenti/özel MCP ekleme seçeneği
hesabında görünmüyorsa [OpenAI’nin güncel kılavuzundan](https://developers.openai.com/api/docs/guides/custom-mcp-server)
ve çalışma alanı izinlerinden kontrol et. Windows kurulumunu tekrar yapmak,
ChatGPT hesabındaki bu özelliği açmaz.

**İki adresin farkı:**

| Adres | Kullanım | ChatGPT sunucu URL alanına girilir mi? |
| --- | --- | --- |
| `https://nexowire-control-plane.nexowire-naveax.workers.dev/` | Cihazı ve hesabı gösteren **kontrol paneli** | **Hayır** |
| `.../connect.html#chatgpt` | MCP adresini gösteren **kurulum sayfası** | **Hayır** |
| `/.well-known/oauth-protected-resource` belgesindeki `resource` alanının **tam HTTPS değeri** | ChatGPT’nin bağlanacağı **MCP sunucu URL’si** | **Evet** |

`resource` değerini bu kılavuzdan tahmin ederek yazma: güncel yayınlanan
belgeden veya bağlantı sayfasındaki kopyala düğmesinden al. Bu adresi
başkasıyla paylaşırken de gizli parametre içermediğinden emin ol.

Örneğin aşağıdaki JSON **yalnız biçimi anlatır, gerçek Nexowire adresi
değildir ve kopyalanıp ChatGPT'ye girilmez**:

```json
{
  "resource": "https://example.invalid/nexowire-mcp",
  "authorization_servers": ["https://example.invalid"]
}
```

Burada sunucu adresi yalnız `resource` değeridir; `authorization_servers`
giriş hizmetini belirtir. Gerçekte yalnız yukarıdaki canlı `.well-known`
belgesinde gördüğün HTTPS `resource` değerini kullan. Panel kök adresini,
`/connect.html` adresini veya örnekteki `example.invalid` alanını girme.

### ChatGPT adresini bulma

**[Nexowire’ın herkese açık bağlantı bilgisini aç](https://nexowire-control-plane.nexowire-naveax.workers.dev/.well-known/oauth-protected-resource).**

Sayfa bir JSON belgesi gösterir. Yalnız **`resource`** alanının tam HTTPS değerini
kopyala. Bu, ChatGPT’ye girilecek sunucu adresidir; bir parola değildir.
`authorization_servers` alanı giriş hizmetini gösterir, MCP adresinin yerine
kullanılmaz. Giriş panelinin adresine kendin `/mcp` ekleyip tahmin etme.

Belge açılmıyorsa veya `resource` yoksa geçerli adres doğrulanamamıştır.
Yanlış adresle ilerleme; hata ekranını paylaşırken oturum bilgilerini gizle.
Bu durumda sorun bir Node/npm eksikliği değildir.

ChatGPT'de **Oluştur / Create** başarısızsa hata metnini kaydet. Önce
ChatGPT hesabında özel MCP sunucusu oluşturma izni olduğunu, ardından
sunucu URL'sinin doğrudan `resource` değerinden geldiğini ve OAuth
seçildiğini kontrol et. İzin yoksa bunu yalnız ilgili çalışma alanı
yöneticisi düzeltebilir; yetkiyi atlatmaya çalışma. URL belgesi erişilemez
veya OAuth akışı hata verirse Nexowire hizmeti tarafında destek gerekir.
**No authentication** seçmek, rastgele `/mcp` eklemek veya Windows kurucusunu
tekrar çalıştırmak bu sorunları güvenli biçimde çözmez.

## 5. Gerçek bağlantıyı dene

Yeni bir ChatGPT sohbetinde `@Nexowire` seç ve şunu gönder:

```text
Nexowire ile cihazlarımı listele. Yeni kurduğum bilgisayarın adını ve çevrimiçi
olup olmadığını göster. Doğru bilgisayarı seçtikten sonra o cihazda yalnızca
sağlık ve makine bilgisi kontrollerini çalıştır. Henüz dosya veya sistem değiştirme.
```

Araç erişimi olan ChatGPT, `devices_list` sonucundan cihazı doğrular; gerektiğinde
panelden/sohbetten tam cihaz seçimi tamamlanır. Ardından `machine_snapshot` ve
`machine_health` başarılı olmalıdır. Eklenti yokken ChatGPT’nin “bağlandım”
demesi veya bilgisayar adını tahmin etmesi bağlantı kanıtı değildir.

Normal Agent kurulumu, fiziksel masaüstü veya CORE/yönetici yetkisinin ayrıca
doğrulandığı anlamına gelmez. Bu durumlar bağlantı kontrolünden ayrı gösterilir.

### Ne kanıtlanmış sayılır?

| Gözlem | Kanıtladığı | Henüz kanıtlamadığı |
| --- | --- | --- |
| Windows kurucusu tamamlandı | Kurulum adımı hata vermeden sona erdi | Cloudflare bağlantısı veya çevrimiçi cihaz |
| Cihaz kontrol panelinde çevrimiçi | Agent hesabınla görünen bağlantı kurdu | ChatGPT eklentisi/OAuth ve araç çağrısı |
| ChatGPT eklentisi oluşturuldu ve OAuth tamamlandı | ChatGPT bağlantı hesabı yetkilendirildi | Seçili cihazda `machine_health` başarısı |
| `devices_list`, `machine_snapshot`, `machine_health` başarılı | Bu sohbet ve seçili cihaz için temel okuma kontrolü yapıldı | CORE, UAC, fiziksel Windows yetkisi veya iki-PC kabulü |

Bir GitHub Actions/Node statik testi, canlı Cloudflare oturumu, gerçek
ChatGPT OAuth girişi, Windows 10/11 kurulum ekranı veya cihazın fiziksel
yetkisi yerine geçmez. Bunlar yapılmadıysa **NOT_RUN** olarak kalır.

## Sorun yaşarsan

| Gördüğün durum | Yapılacak işlem |
| --- | --- |
| GitHub kaynak kod klasörü indi. | Kaynak ZIP’i çalıştırma; yukarıdaki `Nexowire-Setup.cmd` bağlantısını kullan. |
| Dosya `.cmd.txt` olmuş. | Dosya Gezgini’nde dosya uzantılarını göster; resmî `.cmd` dosyasını yeniden indir. |
| Tarayıcı veya SmartScreen dosyayı engelliyor. | Resmî GitHub yayınını ve dosyayı kontrol et. Güvenlik yazılımını veya kurumsal politikayı kapatma; engelin tam metnini kaydet. |
| Kurucu hata veriyor. | Açık kalan hata penceresindeki metni kaydet. GitHub indirmesi, ağ/proxy, disk alanı veya güvenlik engeli olabilir; hata görülmeden “kuruldu” denmez. |
| `Nexowire payload checksum mismatch` görünüyor. | İndirilen paket beklenen dosyayla eşleşmiyor; kurulum burada durur. Ağ/proxy indirmeyi değiştirmiş veya eksik bırakmış olabilir. Bağlantıyı kontrol edip aynı kurucuyu yeniden aç; hash denetimini kaldırma. |
| Eski kurucu `Unable to save shortcut` hatası veriyor. | Bu sayfanın başındaki düzeltilmiş kurucuyu kullan. Var olan cihaz kayıtlarını veya `.nexowire` klasörünü silme. |
| Kurucu bitti, tarayıcı açılmadı. | Başlat → Nexowire ile bir kez daha aç. Yine açılmıyorsa Windows Script Host/politika veya uygulama başlatma hatasını incele; yönetici Broker yardımcı ZIP’ine geçme. |
| Eşleme süresi doldu. | Başlat → Nexowire ile yeni bağlantı isteği aç; yeni tarayıcı sayfasında BAĞLA’yı kullan. Eski sayfayı tekrar tekrar onaylama. |
| BAĞLA düğmesi yok veya sürekli dönüyor. | Genel indirme sayfasını eşleme sanma; cihaz adı bulunan onay ekranını kontrol et. `BAĞLANIYOR…` sırasında bekle; hata oluşursa yukarıdaki güvenli yeniden denemeyi izle. |
| BAĞLA sonrası `TEKRAR DENE` çıktı. | Görünen hata metnini not et, aynı oturumda yalnız bir kez tekrar dene. Hata sürerse yeni oturum aç; cihaz anahtarlarını/yerel kayıtları sıfırlama. |
| `Bu hesap için cihaz limiti dolu` çıktı. | Hesap limitini doğrula; tekrarlanan BAĞLA limiti değiştirmez. Mevcut cihazları veya verilerini rastgele silme. |
| Cihaz panelde çevrimdışı. | PC’nin açık ve internete bağlı olduğunu kontrol et. ChatGPT eklentisini yeniden yüklemek Agent’ın başlamama nedenini çözmez. |
| Panelde cihaz var, ChatGPT’de yok. | İki tarafta da aynı GitHub hesabını kullandığını, eklentinin bağlandığını ve yeni sohbette seçildiğini kontrol et. |
| Bilgisayar başka GitHub hesabına bağlı olabilir. | Yukarıdaki hesap eşleşmesi bölümünü izle; yeniden kurma veya cihazları silme, doğru hesapla OAuth'u tekrar dene. |
| ChatGPT sunucu adresini kabul etmiyor. | Yukarıdaki `resource` değerinin tamamını ve OAuth seçimini kontrol et; panel veya `localhost` adresini kullanma. |
| ChatGPT'de Oluştur başarısız veya eklenti seçeneği yok. | Hesap/çalışma alanı izinlerini ve gerçek hata metnini kontrol et; OAuth'u devre dışı bırakma, API anahtarı paylaşma veya kurucuyu yeniden çalıştırma. |
| `403`, `Access denied` veya `1010` görünüyor. | Hizmete erişim ağ/Cloudflare tarafında reddedilmiş olabilir. Hangi adreste olduğunu ve hata kodunu kaydet. Node kurmak veya Agent verisini silmek bu engeli çözmez. |
| `LOCAL_ENROLLMENT_REQUIRED` görünüyor. | Bu ayrı CORE yerel yetki durumudur. Agent kurulumunu veya veritabanını sıfırlayarak, sahte onayla ya da rastgele yönetici komutlarıyla aşılmaz. |
| `SQLite WAL ... mutation dispatch denied` görünüyor. | İşlem geçmişini, `-wal`/`-shm` dosyalarını veya UNKNOWN kayıtlarını silme. Hata metniyle ayrı günlük incelemesi gerekir. |

Destek isterken Windows sürümünü/mimarisini, indirdiğin **yayın sürümünü**,
takıldığın adımı ve gizlenmiş hata metnini belirt. Şifre, cookie, OAuth kodu,
cihaz anahtarı veya `.nexowire` klasörünün tamamını paylaşma.

### Gizli bilgi paylaşmadan kurulum kontrol listesi

- [ ] Windows 10/11 **x64** ve indirilen resmî `Nexowire-Setup.cmd` sürümü doğrulandı.
- [ ] Dosyanın gerçek uzantısı `.cmd`, kurucu sürümü **v1.0.8**; kaynak ZIP'i değil.
- [ ] Kurulum ekranı veya Başlat → Nexowire üzerinden **cihaz adı** kontrol edildi.
- [ ] BAĞLA sonrası cihaz kontrol panelinde **çevrimiçi** göründü.
- [ ] ChatGPT sunucu adresi panel URL'si değil, yayımlanmış `resource` değeri.
- [ ] ChatGPT’de özel MCP bağlantısı **OAuth** ile ve aynı GitHub hesabıyla kuruldu.
- [ ] Yeni sohbette `devices_list`, `machine_snapshot`, `machine_health` gerçekten başarılı oldu.

Tamamlanmayan maddeleri **başarılı** diye işaretleme. Destek için yalnız
işaretlenmeyen adım ve gizlenmiş hata metni yeterlidir; token, parola,
cookie, OAuth kodu, API anahtarı veya cihazın yerel verileri gerekmez.

## ChatGPT’den adım adım yardım al

[Hazır kurulum mesajını](CHATGPT_INSTALL_PROMPT.md) yeni bir sohbete yapıştır.
Kılavuzun kaynağı [Naveax/Nexowire](https://github.com/Naveax/Nexowire),
ChatGPT ekran adlarının kaynağı [OpenAI belgeleridir](https://developers.openai.com/plugins/quickstart).

İzole Windows CI paket testi Node/npm bulunmayan bir PATH ile kurulum paketini
ve paketteki çalıştırıcıyı sınar. GitHub’da insan olarak giriş yapma, ChatGPT
hesabına eklenti kurma veya gerçek bir kullanıcının PC’sinde fiziksel kabul bu
testin parçası değildir; test fixture’ı bunların yerine geçmez.
