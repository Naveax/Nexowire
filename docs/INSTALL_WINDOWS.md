# İlk bilgisayarı Windows ve ChatGPT’ye bağlama

Bu kılavuz, bilgisayarında Nexowire, Node.js, Git, npm veya bir ChatGPT
eklentisi bulunmadığını varsayar. Kolay kurulum Windows 10/11 **x64** içindir.
Windows’un kendi PowerShell’i kullanılır; PowerShell 7 ayrıca kurulmaz.

Üç farklı durum vardır: **uygulama kurulu**, **cihaz hesabına bağlı** ve
**ChatGPT eklentisi bağlı**. Birinin tamamlanması diğerlerini otomatik olarak
tamamlamaz. Aşağıdaki sırayı takip et.

## 1. Kurulum dosyasını indir

**[Nexowire-Setup.cmd indir](../installers/Nexowire-Setup.cmd?raw=true)**

Bu, depodaki düzeltilmiş kurucudur. **Yayımlanmış v1.0.7** sürümünün değişmeyen
`Nexowire-Windows-x64.zip` dosyasını indirir ve
paketin SHA-256 değerini kontrol eder. Node çalıştırıcısı ve uygulama bağımlılıkları
bu pakettedir; boş bir PC’ye önce Node/npm kurman gerekmez.

Bu kurucu kısayol kaydını Türkçe kullanıcı yollarına uygun Windows Unicode API’siyle
yapar. Önceki resmî yayın dosyaları değiştirilmedi. Bu dosya yeni bir uygulama
yayını veya Nexowire yayıncısı tarafından imzalanmış installer olarak sunulmaz.
[Kaynak ve dosya doğrulaması](../installers/README.md).

GitHub **Code → Download ZIP** kaynak kodu indirir ve bu kurulumun yerine geçmez.
`nexowire-*.tgz` geliştirici paketidir. Ayrı Broker yardımcı ZIP’i ilk kurulum
paketi değildir. [Yayın sayfası](https://github.com/Naveax/Nexowire/releases/latest)
doğrulama dosyalarını da içerir. Paket hash kontrolü, Nexowire uygulamasının
bağımsız yayıncı imzası veya CORE güvenlik kabulüyle aynı şey değildir.

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

### ChatGPT adresini bulma

**[Nexowire’ın herkese açık bağlantı bilgisini aç](https://nexowire-control-plane.nexowire-naveax.workers.dev/.well-known/oauth-protected-resource).**

Sayfa bir JSON belgesi gösterir. Yalnız **`resource`** alanının tam HTTPS değerini
kopyala. Bu, ChatGPT’ye girilecek sunucu adresidir; bir parola değildir.
`authorization_servers` alanı giriş hizmetini gösterir, MCP adresinin yerine
kullanılmaz. Giriş panelinin adresine kendin `/mcp` ekleyip tahmin etme.

Belge açılmıyorsa veya `resource` yoksa geçerli adres doğrulanamamıştır.
Yanlış adresle ilerleme; hata ekranını paylaşırken oturum bilgilerini gizle.
Bu durumda sorun bir Node/npm eksikliği değildir.

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
| Cihaz panelde çevrimdışı. | PC’nin açık ve internete bağlı olduğunu kontrol et. ChatGPT eklentisini yeniden yüklemek Agent’ın başlamama nedenini çözmez. |
| Panelde cihaz var, ChatGPT’de yok. | İki tarafta da aynı GitHub hesabını kullandığını, eklentinin bağlandığını ve yeni sohbette seçildiğini kontrol et. |
| ChatGPT sunucu adresini kabul etmiyor. | Yukarıdaki `resource` değerinin tamamını ve OAuth seçimini kontrol et; panel veya `localhost` adresini kullanma. |
| `403`, `Access denied` veya `1010` görünüyor. | Hizmete erişim ağ/Cloudflare tarafında reddedilmiş olabilir. Hangi adreste olduğunu ve hata kodunu kaydet. Node kurmak veya Agent verisini silmek bu engeli çözmez. |
| `LOCAL_ENROLLMENT_REQUIRED` görünüyor. | Bu ayrı CORE yerel yetki durumudur. Agent kurulumunu veya veritabanını sıfırlayarak, sahte onayla ya da rastgele yönetici komutlarıyla aşılmaz. |
| `SQLite WAL ... mutation dispatch denied` görünüyor. | İşlem geçmişini, `-wal`/`-shm` dosyalarını veya UNKNOWN kayıtlarını silme. Hata metniyle ayrı günlük incelemesi gerekir. |

Destek isterken Windows sürümünü/mimarisini, indirdiğin **yayın sürümünü**,
takıldığın adımı ve gizlenmiş hata metnini belirt. Şifre, cookie, OAuth kodu,
cihaz anahtarı veya `.nexowire` klasörünün tamamını paylaşma.

## ChatGPT’den adım adım yardım al

[Hazır kurulum mesajını](CHATGPT_INSTALL_PROMPT.md) yeni bir sohbete yapıştır.
Kılavuzun kaynağı [Naveax/Nexowire](https://github.com/Naveax/Nexowire),
ChatGPT ekran adlarının kaynağı [OpenAI belgeleridir](https://developers.openai.com/plugins/quickstart).

İzole Windows CI paket testi Node/npm bulunmayan bir PATH ile kurulum paketini
ve paketteki çalıştırıcıyı sınar. GitHub’da insan olarak giriş yapma, ChatGPT
hesabına eklenti kurma veya gerçek bir kullanıcının PC’sinde fiziksel kabul bu
testin parçası değildir; test fixture’ı bunların yerine geçmez.
