# S3-04 — Temiz Windows kabul matrisi

> 31 Ekim 2026 · Yardımcı 2 · source-only / documentation. Kaynak snapshot: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main). Canlı durum ve fiziksel kabul doğrulanmadı.

**Tüm satırlar NOT_RUN / yapılacaklar.** Bu Linux clone'da installer çalıştırılmadı. Ayrı atılabilir Windows lab/VM ve ayrıca izin gereklidir. Kullanıcının iki gerçek bilgisayarı kapsam dışıdır. Canlı cihaz, servis, görev zamanlayıcısı veya ağ ayarı değişikliği yetkisi verilmez.

| ID | Önkoşul / durum | Beklenen / gözlem | Tür / bağımlılık | Sonuç |
|---|---|---|---|---|
| W10 | Windows 10 x64 | İlk kurulum; doğru payload/runtime/kısayol; sonuç kaydı | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| W11 | Windows 11 x64 | Aynı kabul ölçütü; işletim sistemi sürümü kaydı | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| USER | Admin olmayan hesap | Normal kurulum yükseltme istememeli; CORE ayrı | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| UNICODE | Türkçe/Unicode kullanıcı yolu | Kısayol hedef/argüman ve normal açılış; kişisel yolu raporda gizle | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| FIRST | İlk kurulum | Temiz profil; önceden Node/npm/Git/PS7 olmadan paket bütünlüğü | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| UPDATE | Güncelleme | Önce/sonra sürüm; mevcut kimlik ve geçmiş korunmalı | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| REPAIR | Onarma | Desteklenen onarım yolu önce ana ekipten doğrulanmalı; komut uydurma | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| CANCEL | İptal | İndirme/kurulum aşamasında iptal; yarım paket başarı görünmemeli | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| ROLLBACK | Rollback | Onaylı downgrade/rollback yolu ve veri uyumu önce ana ekipçe belirlenmeli | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| REBOOT | Reboot/relogin | Aynı cihaz/hesap; online ve sağlık kontrolü; fiziksel oturum ayrıca | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| NETWORK | Kötü ağ/kesinti | Eksik indirmede fail-closed, başarısız eşleme başarı sayılmamalı | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| DISK | Düşük disk | Açıklayıcı hata, sağlam kurulum veya önceki veriye zarar yok | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| PROXY | Kurumsal proxy | Onaylı proxy ile davranış; TLS doğrulaması korunmalı | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| HASH | Checksum mismatch | Bozuk payload reddi; kurulum/başlatmaya geçiş olmamalı | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |
| REMOVE | Kaldırma | Yalnız belgelenmiş kaldırma yolu; veri saklama kararını ana ekip versin | Ayrı izinli disposable Windows lab; sürümü sabit release, checksum, ekran/hata kanıtı | NOT_RUN |

Her satır için ID, kaynak issue (#484 kota ayrı; kurulum README/INSTALL_WINDOWS), test branch ve exact SHA, paket sürümü/hash, Windows build/mimari, tarih UTC, komut/adımlar, beklenen/gözlenen, exit code, kanıt türü ve CI ID tutulmalı. Hiçbir NOT_RUN satırı sentetik fixture sonucu ile PASS'a çevrilmez. OAuth ve ChatGPT için ayrıca yetkili insan hesabı gerekir; test hesabı/sentetik arayüz fiziksel acceptance değildir.

## Burada yapılabilen statik inceleme

Snapshot'ta `installers/Nexowire-Setup.cmd` ilk satırları v1.0.7 pin, SHA256 ve GitHub ZIP URL'si içeriyor. `installers/README.md` aynı sürüm/hash ile tutarlı. `README.md` ve `docs/INSTALL_WINDOWS.md` Windows 10/11 x64 ve normal kullanıcı kurulumunu belgeliyor. Bunlar **source-only**, Windows yürütme sonucu değildir. Latest release API v1.0.8 metadata'sı ayrı doğrulandı; imzalı installer veya cihazda v1.0.8 kurulumu kanıtlanmadı. Sürüm farkı S3_TWO_STEP_INSTALL.md'de kaydedildi.

İmzalı installer yayıncı sertifikası, temiz Windows fiziksel kabulü, güncelleme/onarma/rollback/kaldırma davranışı için burada çalışma kanıtı yok. Ana ekip yayımlanmış paket ile bootstrap sürümünü ve desteklenen yaşam döngüsü adımlarını doğrulamalı.

Kaynaklar: [INSTALL_WINDOWS](../INSTALL_WINDOWS.md), [installers README](../../installers/README.md), [bootstrap](../../installers/Nexowire-Setup.cmd), [yayın](https://github.com/Naveax/Nexowire/releases/tag/v1.0.8). PR #971/#979 kurulum geçmişidir; açık #984 opt-in enrollment installer çalışması normal kullanıcı kabulü yerine geçmez.

## Prototip kontrolleri (Windows kabulünden ayrı)

Linux üzerinde yerel `node --input-type=commonjs` doğrulaması: iki HTML'de görünür DEMO metni, `connect-src 'none'`, dış src/href/form/iframe bulunmaması ve ağ/credential-storage API çağrısı bulunmaması doğrulandı. Onboarding inline JS'i `node:vm` ve basit sentetik DOM stub ile başlangıç, loading, installed, signin, error, success, retry ve focus hedefi açısından kontrol edildi; exit 0. Yerel Markdown hedefleri Python pathlib ile kontrol edildi; exit 0.

Gerçek headless Playwright denemesi **BLOCKED**, exit 1: kurulu Chromium çalıştırıcısı yok. Görsel düzen, 390/1280 px overflow, gerçek klavye/ekran okuyucu kabulü doğrulanmadı. CSS media query, label, native button/select, focus-visible ve aria-live kaynakta mevcut; bunlar görsel/erişilebilirlik testi PASS anlamına gelmez. Ana ekip ayrı yerel tarayıcı incelemesi yapmalıdır. Kullanıcının tarayıcısı kullanılmadı.
