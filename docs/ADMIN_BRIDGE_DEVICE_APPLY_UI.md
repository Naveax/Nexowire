# Admin Bridge | Cihazda Uygula arayüzü

PC Settings > ADMIN BRIDGE bölümünde mevcut AUTO / ON / OFF anahtarları **yalnızca sahibi tarafından istenen tercihi** kaydeder. Bunlar kendi başlarına Windows Broker görevini başlatmaz veya durdurmaz.

Yeni **Seçilen modu cihazda uygula** düğmesi ise, yalnızca çevrimiçi Windows + FULL + Broker modunu bildiren cihazlarda açılır. Açıldıktan sonra ayrı bir `APPLY BRIDGE MODE` yazılı onayı gerektirir.

- Onayla isteği `POST /api/v1/me/devices/bridge-command` endpoint'ine `X-Nexowire-Confirm: bridge-command-issue-v1` başlığıyla gönderilir.
- Sunucu `queued` döndürdüğünde sayfa **yalnız kuyruğa alındı** bildirir, Broker görevini başlatılmış saymaz.
- `GET /api/v1/me/devices/bridge-command/status?requestId=...` ile sahibi ve cihazı bağlı istek kimliği üzerinden takip edilir.
- `queued` / `claimed` durumları başarı değildir. Yalnız `applied` durumu geldiğinde, sunucudaki Guardian imza ve mevcut cihaz eşleştirme kontrollerinin başarılı sonucu olarak kabul edilerek cihaz telemetrisi yenilenir.
- `failed`, `expired`, yanlış istek/cihaz kimliği, servis yokluğu ve yetki hatalarında cihazın durumu başarılı gösterilmez.
- Sayfa içindeki eşzamanlı tekrarlı onaylar engellenir.
- Kaydedilen tercih değiştiğinde otomatik bir komut gönderilmez.

**Önemli sınır:** HTTP taşıması sunucu ayarıyla varsayılan kapalıdır. İmzalı Guardian cihaz anahtarı ve yerel Broker komut alıcısı dağıtılmamışsa bu özellik `BRIDGE_COMMAND_TRANSPORT_DISABLED` döndürür; gerçek Windows Scheduled Task işlemi yapıldığı iddia edilmez. Bu değişiklik tek başına köprü hizmetini üretimde açmaz.

Windows DEV'de web JavaScript sözdizimi, owner phrase, tek istek/kuyruk, imzalı sonucu bekleme, disabled transport, yanlış cihaz/istek kimliği, hata ve cihaz iç API kabul testleri **19/19 PASS**. TypeScript ve derleme PASS.

Bu yalnız UI ve mevcut imzalı-komut API entegrasyonudur. Canlı Guardian imza anahtarı kurulumu, Hub-Agent-Broker taşıma kanalı, yerel Windows task kontrolü, yeniden bağlanma/rollback ve üretim kabulü #323 / #260 altında sürüyor. Güvenlik konusu #271 kullanıcı isteğiyle ertelenmiştir; hiçbir üretim ACL, task veya ayrıcalıklı Broker işlemi değiştirilmedi.
