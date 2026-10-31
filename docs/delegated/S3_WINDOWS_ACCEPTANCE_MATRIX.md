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

## İkinci tur — prototip görsel / gerçek klavye doğrulaması

31 Ekim 2026. İncelenen PR #998, başlangıç exact HEAD `9d0560c4b1369ed79dc63bea8b1644ad18150f28`; Linux, Node v24.22.1. Bu tur yalnız bu QA kaydını günceller; iki HTML değişmedi. Üretim paneli/OAuth veya kullanıcının tarayıcısı açılmadı.

### Ortam sonucu

- Yerel PATH'te `chromium`, `chromium-browser`, `google-chrome` yok; /opt, /usr/bin, /tmp ve tarayıcı cache taramasında çalıştırılabilir tarayıcı bulunmadı.
- Runtime Playwright paketi mevcut. Geçici klasöre yalnız test tarayıcısı kurulumu denendi:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/nexowire-helper2-browsers \
node /opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/cli.js \
install chromium --only-shell
```

Sonuç: **BLOCKED**, exit 1. Playwright'ın otomatik indirme denemeleri `End of central directory record signature not found` ve `Failed to install browsers` ile bitti. Gözlenen, geçerli ZIP elde edilememesidir; bunun kesin ağ/proxy nedeni doğrulanmadı. Başka kaynaktan binary indirilmedi, ağ/güvenlik ayarı değiştirilmedi.

### Kontrol matrisi

| Kontrol | Onboarding | Quota preview | Kanıt / sınır |
|---|---|---|---|
| DEMO ibaresi kaynakta | PASS (statik) | PASS (statik) | Gerçek ekranda görünürlük NOT_RUN |
| Dış ağ / credential storage API çağrısı yok; connect-src none | PASS (statik) | PASS (statik) | Ağdan bağımsız kaynak kontrolü; browser runtime ölçümü yapılmadı |
| 1280×900 masaüstü düzen | BLOCKED | BLOCKED | Render motoru yok |
| 390×844 ve 320×800 dar ekran; yatay taşma | BLOCKED | BLOCKED | Media query kaynakta var; scrollWidth ölçülmedi |
| Gerçek Tab / Shift+Tab sırası | BLOCKED | BLOCKED | Quota sayfasında etkileşimli kontrol yok; Tab trap olmaması yine browser kontrolü gerektirir |
| Görünür klavye odağı | BLOCKED | Uygulanabilir kontrol yok | Onboarding focus-visible CSS mevcut; çizildiği gözlenmedi |
| Select label eşleşmesi | PASS (statik) | Form kontrolü yok | for=state → id=state; erişilebilir adın browser ağacındaki sonucu NOT_RUN |
| Hata ve retry | PASS (kaynak eşlemesi); browser BLOCKED | Sabit dolu/bilinmiyor kartları; browser BLOCKED | bind→error, retry→signin; gerçek klavyeden etkinleşme gözlenmedi |
| Ekran görüntüsü | YOK | YOK | Render edilmeden görüntü üretilmedi |

Yenilenen statik kontrol `node --input-type=commonjs` ile iki HTML'yi okuyup node:assert/strict kullanarak DEMO metni, CSP connect-src none, dış src/href/form/iframe olmaması, fetch/XMLHttpRequest/WebSocket/storage çağrılarının olmaması, 480px media query ve focus-visible kaynağını doğruladı (exit 0). Onboarding label eşleşmesi, aria-live, pozitif tabindex olmaması ve error/retry state eşleşmesi de kontrol edildi (exit 0). Bunlar görsel veya gerçek klavye PASS değildir. Önceki DOM stub sonucu gerçek klavye yerine kullanılmadı.

### Gereken ortam ve tamamlanacak adımlar

Gereken: izole Linux/Windows test ortamında **çalışabilir Chromium + işletim sistemi bağımlılıkları ve uyumlu Playwright**; alternatif olarak yerel dosya açabilen izole manuel masaüstü tarayıcı. Yetkili sağlanmış browser binary'si veya Playwright CDN'den sağlam indirme gerekir. Üretim hesabı, OAuth, canlı cihaz, admin/CORE, sunucu veya localhost gerekmiyor. Yalnız `file://.../docs/delegated/prototypes/{onboarding,quota-preview}.html` açılmalı; HTTP(S) istekleri test harness'inde reddedilmeli.

1. Her iki sayfayı 1280×900, 390×844 ve 320×800 viewport'ta aç. Sayfa zoom %100, sonra %200 için metin/kontrol kesilmesini incele. `document.documentElement.scrollWidth <= innerWidth` ölç; yatay taşma varsa hangi elementin sınırı geçtiğini kaydet.
2. Onboarding başlangıcında sayfayı yeniden yükle. Mouse veya locator.focus kullanmadan Tab ile beklenen sırayı gözle: `state → download → installed`. Her durakta `document.activeElement.id`, `:focus-visible` ve computed outline kaydet; gerçek çizimi ekran görüntüsünden kontrol et. Shift+Tab ters sırayı izlemeli.
3. `installed` üzerinde Enter kullan. State seçicisine odak dönmeli. Ardından Tab: `download → installed → signin → bind`. Başka pencere açılmamalı, HTTP(S) isteği olmamalı.
4. `bind` üzerinde Space ile örnek hata açılmalı; odak state'e dönmeli. Sonraki Tab sırası `download → installed → signin → bind → retry` olmalı. Retry'da Enter: hata gizlenmeli, signin durumu görünmeli, odak state'e dönmeli. Gizlenen retry odağı tutmamalı.
5. Select'i gerçek Arrow/Home/End tuşlarıyla kullanıp altı durumu incele: start/loading/installed/signin/error/success. Loading'de disabled download Tab'da atlanmalı. Label tıklaması select'e odaklanmalı; label'dan browser erişilebilir adı “Sentetik ekran” olmalı. Canlı bölge metin değişimini kontrol et; gerçek ekran okuyucu testi ayrı kaydedilmeli.
6. Quota'da normal/dolu/bilinmiyor durumlarını ve UTC dönem/reset metnini her genişlikte kontrol et. Progress erişilebilir adları 275/1000 ve 1000/1000 durumlarıyla tutarlı olmalı. Yanlışlıkla klavyeyle çalışan gizli kontrol veya odak tuzağı olmamalı.
7. Başlangıç, odaklı kontrol, hata, retry sonrası ve kota kartlarının ekran görüntülerini temp veya `docs/delegated/output/` altında kaydet. Sonuçları browser sürümü, viewport, komut, exact SHA, exit code ve gözlenen durumla ilişkilendir. Bu adımlar henüz çalıştırılmadı; ekran görüntüsü mevcut değil.

Sonuç: **S2-03 / S3-03 görsel ve gerçek klavye kabulü hâlâ PARTIAL / BLOCKED**. Kaynakta gözlenen bir UI kusuru olmadan HTML değişikliği yapılmadı. Ana ekip yalnız çalışabilir izole browser ortamını sağlayarak yukarıdaki kontrolleri tamamlayabilir; üretim/OAuth erişimi gerekmiyor.
