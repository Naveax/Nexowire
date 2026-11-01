# Nexowire: ilk cihazı bağlayamıyorum — güvenli teşhis rehberi

Bu sayfa, **Windows 10/11 x64 son kullanıcısının** sorunun hangi adımda olduğunu
bulmasına yardımcı olur. Her adımda yalnızca gözlem yap; başkasının hesabını,
cihazını veya gizli anahtarını kullanma. Canlı hizmetin şu an çalıştığı bu
belgeyle doğrulanmış değildir.

## Önce üç ayrı durumu ayır

1. **Kuruldu mu?** Başlat menüsünde Nexowire var mı ve kurulumun tarayıcı
   penceresi açılıyor mu? Dosyayı yanlış PC'de çalıştırmak cihazı başka
   bilgisayara taşımaz.
2. **Cihaz hesabına bağlandı mı?** Tarayıcıda kendi GitHub hesabınla oturum
   açıp **BAĞLA** adımını tamamladın mı? [Kontrol panelinde](https://nexowire-control-plane.nexowire-naveax.workers.dev/)
   cihaz çevrimiçi mi? Kurucu pencerenin kapanması yeterli kanıt değildir.
3. **ChatGPT bağlandı mı?** Nexowire özel MCP bağlantısında OAuth tamamlandı mı,
   yeni sohbette `@Nexowire` seçildi mi? `devices_list` cihazı gösterip
   `machine_snapshot` ve `machine_health` başarılı oldu mu? Bunlar olmadan
   “her şey hazır” deme. CORE/yönetici yetkisi ayrı bir konudur.

## Ekrandaki belirtiye göre ilerle

| Belirti | Güvenli sonraki adım | Henüz kanıtlanmayan |
| --- | --- | --- |
| Kaynak ZIP indi veya dosya `.cmd.txt` oldu. | [Resmî README'deki sürüme sabitlenmiş Windows kurucusunu](../../../README.md#1-indir-ve-aç) kullan; dosya uzantısını göster. | Bu dosyalar kurulumun başladığını göstermez. |
| SmartScreen, antivirüs veya kurum politikası engelledi. | GitHub yayın kaynağını ve tam hata metnini kontrol et; yetkili destekten yardım iste. | Engeli kapatmak güvenli bir çözüm değildir. |
| Kurucu hata verdi veya `checksum mismatch` dedi. | İndirilen yayın/sürüm ve hata metnini kaydet; [Windows kılavuzundaki güvenli adımları](../../INSTALL_WINDOWS.md#sorun-yaşarsan) izle. | Hash denetimini atlamak paketi doğrulamaz. |
| Tarayıcı açılmadı. | **Başlat → Nexowire** üzerinden bir kez yeniden aç; yine açılmazsa hata metnini al. | Agent veya hesap bağlantısı doğrulanmadı. |
| BAĞLA düğmesi yok; yalnız kurulum ekranı var. | Bağlama isteğinin açıldığı bilgisayarda resmî Nexowire kısayolundan bağlantı akışını başlat. | Elle oluşturulmuş bağlantı URL'si gerçek pairing oturumu değildir. |
| GitHub girişi yeniden isteniyor. | Yalnız resmî GitHub OAuth sayfasında **kendi hesabınla** giriş yap; sonra aynı sayfaya dön. | Giriş yapılması cihazın çevrimiçi olduğunu kanıtlamaz. |
| BAĞLA → “Bu hesap için cihaz limiti dolu” (`DEVICE_LIMIT_REACHED`). | Hesabın kota/cihaz sınırını kontrol et; gerekiyorsa yetkili destekten açıklama iste. | Yeniden tıklamak limiti kaldırmaz; başka cihazı silme. |
| BAĞLA → “Bağlantı hazırlanamadı” veya “TEKRAR DENE”. | İnternet ve hizmet erişimini kontrol et; yalnız hata ekranı izin veriyorsa aynı oturumda **bir kez** yeniden dene. Süre dolduysa Başlat → Nexowire ile yeni bağlantı isteği aç. | Hata nedeni (ağ, hesap, sunucu) belli değildir. |
| Cihaz panelde var ama çevrimdışı. | Cihaz açık mı, ağ çalışıyor mu, Nexowire normal yoldan başlıyor mu kontrol et. | Eklentiyi yeniden eklemek Agent'ı çevrimiçi yapmaz. |
| Panel çevrimiçi, ChatGPT cihazı görmüyor. | Aynı GitHub hesabını, OAuth bağlantı durumunu, yeni sohbette `@Nexowire` seçimini ve doğru cihazı kontrol et. | Panel durumu tek başına MCP sağlığını kanıtlamaz. |
| ChatGPT sunucu adresini reddediyor. | Aşağıdaki **MCP adresi** adımını uygula; OAuth seçimini koru. | Panel URL'si veya tahmin edilen `/mcp` yolu doğru adres sayılmaz. |
| HTTP `401`/`403`, `Access denied` veya Cloudflare `1010`. | Kodu ve adresin **alan adını** (token/URL query olmadan) not et. Kendi hesap oturumunu ve hizmet erişimini yetkiliye bildir. | İzin veya güvenlik engeli cihaz sıfırlanarak aşılmaz. |
| HTTP `503` veya zaman aşımı. | Hizmet/bağlantı erişimini yeniden gözlemle; mümkünse saat ve HTTP durumunu kaydet. | İstek sunucuya ulaşıp ulaşmadığı ve neden başarısız olduğu bilinmez. |
| `LOCAL_ENROLLMENT_REQUIRED` veya `SQLite WAL ... mutation dispatch denied`. | Hata kodunu yetkili incelemeye ilet; işlem yapmayı durdur. | CORE/WAL sorunu kurulum ekranını değiştirerek çözülmez. |

## ChatGPT için doğru MCP adresi

1. [Nexowire bağlantı sayfasının ChatGPT bölümünü](https://nexowire-control-plane.nexowire-naveax.workers.dev/connect.html#chatgpt)
   aç. Adres alanı dolmamışsa bunu başarısız kabul et.
2. Alternatif olarak [herkese açık OAuth resource belgesini](https://nexowire-control-plane.nexowire-naveax.workers.dev/.well-known/oauth-protected-resource)
   aç. Belge sağlıklı JSON dönüyorsa **`resource` alanındaki tam HTTPS adresini**
   kopyala. `authorization_servers` alanı veya kontrol paneli URL'si yerine geçmez.
3. ChatGPT'de özel MCP bağlantısını **Nexowire / OAuth** olarak kur; kendi GitHub
   hesabınla giriş yap. `localhost`, `127.0.0.1`, elle tahmin edilmiş `/mcp`
   adresi, boş veya yönlendirilmiş sayfa ile ilerleme. Form parola ya da sabit
   istemci anahtarı istiyorsa rastgele bilgi girme ve OAuth'u kapatma.
4. Eklenti zaten bağlıysa ikinci kopyasını oluşturma; yeni sohbet açıp doğru
   eklentiyi ve cihazı seç. İlk deneme salt-okunur olsun: `devices_list`,
   `machine_snapshot`, `machine_health`.

## Destek isterken bunu paylaş

- Windows sürümü ve x64 olup olmadığı, Nexowire yayın sürümü, takıldığın **1/2/3**
  adımı, yaklaşık saat, hata kodu ve gizli bilgiler çıkarılmış ekran görüntüsü.
- **Paylaşma:** GitHub şifresi, doğrulama kodu, OAuth `code`/`state`, çerez,
  pairing `token`, cihaz anahtarı, bağlantı adresinin gizli sorgu parametreleri,
  `.nexowire` klasörü veya yerel veritabanları.
- **Yapma:** güvenlik yazılımını kapatma, yükseltilmiş yönetici/broker çalıştırma,
  bilinmeyen kurucuya geçme, WAL/SHM/UNKNOWN kayıtlarını silme, başka hesaba
  bağlanma, eski pairing URL'sini defalarca açma.

**Kaynak/kapsam notu (2026-11-01):** Bu rehber 
[`README.md`](../../../README.md),
[`docs/INSTALL_WINDOWS.md`](../../INSTALL_WINDOWS.md),
[`web/connect.js`](../../../web/connect.js) kaynaklarının
`Naveax/main` **`93b6df33ef58610dcfdf3584bfe774e5afa7df4d`** durumuna göre
hazırlandı. README resmî **v1.0.8** kurucusunu gösterirken `web/connect.js`
kurulum sekmesinde geçmiş **v1.0.7** metni ve bir commit'e sabitlenmiş
kurucu bağlantısı içeriyor. Bu tutarsızlık K06/kurulum sahibi tarafından
çözülene kadar, sırf bir web sekmesinin metnine bakarak yeni sürüm kanıtı
üretme; resmî GitHub yayınını esas al. Bu belge herhangi bir canlı servis,
Windows cihazı veya ChatGPT hesabında test edilmedi.
