# Nexowire’ı ilk kez kurdurmak için ChatGPT mesajı

Aşağıdaki mesajın tamamını yeni bir sohbete yapıştır. Nexowire eklentisi önceden
kurulu olmak zorunda değildir. ChatGPT’nin yerel bilgisayar erişimi yoksa dosyayı
sen indirip açarsın; erişim varsa izin verilen işleri kendisi yapabilir.

```text
Bu Windows bilgisayarına Nexowire’ı sıfırdan kurmama yardım et. Daha önce
Nexowire kurmadım, cihaz eşlemedim ve ChatGPT’ye Nexowire eklentisi eklemedim.
Node.js, npm, Git veya Python kurulu olduğunu varsayma.

Nexowire’ın resmî deposunu ve bu mesajla verilen kurulum kılavuzunu esas al:
https://github.com/Naveax/Nexowire
Kılavuz bir geliştirme dalından geldiyse aynı dalın sürümünü oku. Aşağıdaki
adımlar kendi başına da kullanılabilir; yayımlanmamış bir özelliği var sayma.

Yapılacak sıra:
1. Windows’un desteklenen x64 sürümünde olduğumu doğrula. Normal kullanıcı
   kurulumunu kullan; kendi sunucumu, Tailscale’i veya yönetici Broker’ı kurdurma.
2. Bu kılavuzla aynı dalın README'sindeki Nexowire-Setup.cmd indirmesini kullan.
   Düzeltilmiş kurucu: installers/Nexowire-Setup.cmd (dosya görünümünde Download raw).
   Bu kılavuzun yayımlandığı dal:
   https://github.com/Naveax/Nexowire/tree/fix/first-pc-onboarding-guide-20261029
   Kurucu yayımlanmış v1.0.7 uygulamasını kullanır; yeni sürüm veya imzalı
   installer diye sunma. Önceki resmî yayın:
   https://github.com/Naveax/Nexowire/releases/tag/v1.0.7
   Kaynak ZIP’ini veya geliştirici .tgz paketini ilk kurulum gibi kullanma.
   Paket kendi Node çalıştırıcısını getirir; önceden npm/Node kurdurma.
3. Bilgisayarımda yetkili yerel araçların varsa indirme ve kurulum durumunu
   onlarla incele. Böyle araçların yoksa bilgisayarıma erişebiliyormuşsun gibi
   konuşma; indirilecek tek dosyayı ve sıradaki kısa adımı göster.
4. Açılan resmî tarayıcı ekranında kendi GitHub hesabımla giriş yapmamı ve
   BAĞLA’ya basmamı sağla. Şifre veya doğrulama kodumu sohbete isteme.
5. Kontrol panelinde bu PC çevrimiçi görünmeden bağlantı tamamlandı deme.
6. ChatGPT’de Nexowire eklentisi yoksa resmî OpenAI kılavuzuna göre özel MCP
   bağlantısı eklememe yol göster. Sunucu URL’sini Nexowire’ın herkese açık
   .well-known/oauth-protected-resource belgesindeki resource alanından al;
   https://nexowire-control-plane.nexowire-naveax.workers.dev/.well-known/oauth-protected-resource
   giriş paneline /mcp ekleyip tahmin etme. Kimlik doğrulama OAuth olmalı.
   Eklenti ile cihaz eşlemesinde aynı GitHub hesabını kullanmalıyım.
7. Yeni sohbette eklenti seçildikten sonra devices_list ile doğru PC’yi doğrula.
   Gerekli cihaz seçimi tamamlandıktan sonra yalnız machine_snapshot ve
   machine_health kontrollerini yap. Bunlar gerçekten başarılı olmadan
   kurulumu veya bağlantıyı başarılı sayma.

Adımları kısa ve sırayla anlat. Yapabildiğin yetkili işleri kendin tamamla;
yalnız benim giriş yapmam veya gerçek bir düğmeye basmam gereken yerde dur.
OpenAI API anahtarı, cihaz anahtarı, cookie, parola veya OAuth kodu isteme.
Engel çıkarsa tam adımı ve gizlenmiş hata metnini kullan; politika/antivirüs
kapatma, yönetici yükseltme veya işlem günlüğünü silme gibi kestirmeler üretme.
Mevcut kurulumu, çalışan diğer cihazları veya projeleri değiştirme.
Agent bağlantısını CORE/yönetici veya fiziksel masaüstü yetkisi gibi sunma.
```

ChatGPT bağlantısının resmî kılavuzu:
https://developers.openai.com/api/docs/guides/custom-mcp-server
