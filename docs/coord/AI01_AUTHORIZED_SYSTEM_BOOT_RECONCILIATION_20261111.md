# AI-01: Yetkili eski SYSTEM Hub görevi uzlaştırması

Eski **Nexowire Hub Boot** görevi, Task Scheduler ACL nedeniyle yükseltilmemiş oturumdan görünmeyebilir. Boş görev listesi, Get-ScheduledTask başarısızlığı veya Access denied kesin yokluk kanıtı değildir. Körlemesine Unregister-ScheduledTask çalıştırmayın.

## Operasyonel sözleşme

Üretim bakım aracı: `scripts/Resolve-Nexowire-LegacySystemHubTask.ps1`.

Her değiştirici işlem açıkça yükseltilmiş yönetici tokenı ve aşağıdaki özel ACL'li Program Files kopyasını gerektirir:

`C:\Program Files\Nexowire\SystemHub\scripts\Resolve-Nexowire-LegacySystemHubTask.ps1`

`Inspect`, geliştirme worktree'sinden salt okunur çalışabilir. Araç kendi kendine yükselmez, UAC/CORE iptalini aşmaz, kullanıcı Hub'ını durdurmaz, SQLite'ya dokunmaz.

İmzalı/sabitlenmiş runtime önce mevcut `Install-Nexowire-SystemHubRuntime.ps1` ile doğrulanıp yerleştirilmeli, AI-04 ile eşzamanlı Hub/SQLite değişikliği yapılmamalıdır.

1. `-Action Inspect`: görev görünürlüğünü ve SYSTEM kimliğini salt okunur sorgula.
2. `-Action Backup`: doğrulanan görev XML'ini, task SDDL bilgisini ve hash'lenmiş eski launcher kopyasını korunan ProgramData alanına yaz; yedek ID ve SHA-256 fişini kaydet.
3. `-Action Verify -BackupId <GUID> -ExpectedReceiptSha256 <SHA256>`: kaydın ve yedek dosyaların bütünlüğünü doğrula.
4. `-Action Rehearse -BackupId <GUID> -ExpectedReceiptSha256 <SHA256>`: yedek XML ile ayrı **disabled** test görevi kaydet, incele ve kaldır. Bu test gerçek reboot/rollback yerine geçmez.
5. `-Action Retire -BackupId <GUID> -ExpectedReceiptSha256 <SHA256> -ExpectedRuntimeTreeSha256 <PINNED_SHA256> -ApproveRetirement`: **yalnızca fiziksel rollback önkoşulları ayrıca kabul edildiyse** mevcut görev hâlâ aynıysa, eski SYSTEM görevi Ready/Disabled ise, kullanıcı Hub'ı Running ise, prova kanıtı tamamsa ve Program Files runtime hash'i sabitlenmiş paketle eşleşirse görevi kaldır.
6. `-Action Restore -BackupId <GUID> -ExpectedReceiptSha256 <SHA256>`: yalnızca görevin kesin yokluğu kanıtlandığında yedekten XML+SDDL ile geri kaydet; görünmeyen/yeniden beliren görevin üzerine yazma.

Geri yükleme için korumalı yedek klasöründeki `Restore-Task.ps1` nüshası kullanılmalıdır. Eski runtime ve kullanıcı Hub'ı bu araç tarafından silinmez veya durdurulmaz.

## Kabul sınırları

- Görev silme bir SYSTEM Hub cutover işlemi değildir. Gerçek Windows reboot, DPAPI/SQLite migrasyonu ve fiziksel rollback kabulü #1161 kapsamında hâlâ gereklidir.
- Yerel yükseltilmiş oturum ve korumalı Program Files erişimi olmadan **Backup, Rehearse, Retire, Restore yapılmamalıdır**.
- AI-06'nın bu aracı Windows release payload dosya listesine ve release manifest kontrollerine eklemesi gerekir. AI-01 dalı AI-06 sahipliğindeki manifestleri değiştirmez.
