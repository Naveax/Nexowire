# Nexowire AI-01 | Work-PC SYSTEM Hub Boot kaynak teslimi

Tarih: 2026-11-08
Kaynak: `Naveax/Nexowire` PR #1096, başlangıç HEAD `43e8125e7a4ced654a769b661dc10938c02bc7a4`
İş dalı: `agent/ai01-system-hub-boot`

## Canlı kanıt ve kapsam
- Work-PC `DESKTOP-ONDD84S`: `Nexowire Hub Boot` **kurulu değil**. Mevcut `Nexowire Hub` `umut` Interactive/Limited/AtLogon altında **Running**. HTTP portu 43110; SQLite durumu `C:\Users\umut\.nexowire\hub` altında korunuyor.
- Work-PC `Nexowire Privileged Broker`: **Running**, kullanıcı `umut`, Interactive/Highest, MultipleInstances=IgnoreNew, son görev sonucu `0x800710E0`.
- NAVEAX Broker (yalnız salt-okunur): **Running**, kullanıcı `navea`, Interactive/Highest, MultipleInstances=IgnoreNew, son görev sonucu `0x800710E0`.
- `0x800710E0` ile `IgnoreNew` birlikteliği, ikinci başlatma reddiyle uyumludur; sağlık/elevation kanıtı değildir. `Highest` ve `SYSTEM` aynı kimlik değildir.
- Fiziksel restart/oturum öncesi Agent/Hub erişimi, cihaz güç kesintisi, canlı SQLite cutover, resmi imzalı paket ve üretim rollback: **NOT_RUN**. Reboot yapılmadı. NAVEAX'a değişiklik yapılmadı.

## Kaynak düzeltmeleri
- Handoff öncesi user Hub Scheduled Task state anlık alınır ve registration öncesinde karşılaştırılır; beklenmedik yarış reddedilir.
- Eski Hub durdurulduktan sonra 43110 gibi seçilen porta bağlı dinleyici varsa 15 saniye sınırlı izlenir; port doluysa SYSTEM Hub başlatılmaz, kontrollü rollback tetiklenir.
- LocalMachine DPAPI / launcher hazırlama hataları yalnız installer'ın oluşturduğu ve ACL ile doğrulanmış protected root üzerinde temizlenir. Hata halinde kanıt kaybını önlemek için belirsiz/başka sahibin dosyaları silinmez.
- Başarısız kurulum ve boot-uninstall eski kullanıcı görevini önceden `Running` ise başlatır, `Ready` ise yalnız etkinleştirir; önceden `Disabled` ise etkinleştirmez.
- Uninstall, eski görevin durumunu lifecycle manifestinden alır; SYSTEM listener portu serbest kalmadan eski Hub'a geçmez.
- `scripts/Install-Nexowire-SystemHubRuntime.ps1` eklendi: read-only `-Action Plan` varsayılan; sadece operator onayıyla `-Action Install`. SHA-256 sabitlenen tam runtime, signed Node, Program Files private ACL, symlink ve disk kontrolleri; canlı Hub/SQLite/Scheduled Task değiştirilmez.

## Test ve kabul sınırı
- 45 odaklı Hub, task, listener, privileged runtime testleri: **PASS**.
- 1 gerçek Windows PowerShell 5.1 Program Files `Plan` / yanlış hash `Install` engelleme testi: **PASS**.
- `npm run typecheck` ve `npm run build`: **PASS**.
- `nexowire hub boot-status`: `installed=false`, `state=not-installed`, `userTaskState=running`.
- Bunlar **kaynak ve salt-okunur Windows testleridir**; `AtStartup` fiziksel önyükleme kabulü değildir.

## Sonraki kontrollü canlı kabul
1. İmzalı, eksiksiz Windows paketi belirle; CI kaynak SHA ve resmi yayın digestini bağımsız doğrula. `Plan` ile kaynak ağacı SHA-256 değerini karşılaştır. Mevcut Git worktree'sini doğrudan SYSTEM çalışma kökü olarak kullanma.
2. Yönetici oturumundan `-Action Install -SourceDirectory <trusted-package> -ExpectedTreeSha256 <trusted-sha256>` ile Program Files çalışma ortamını yükle; read-only ownership ve signing preflight'i tamamla.
3. SQLite state/WAL'ın SYSTEM erişim ve owner planını, çalışan kullanıcı Hub'ından güvenli ve geri alınabilir aktarımını ve DPAPI CurrentUser -> LocalMachine aktarımını onayla.
4. Elevated signed runtime CLI üzerinden `hub boot-install`; mevcut kullanıcı task'ının devre dışı, SYSTEM/AtStartup görevinin kayıtlı, portun tek sahipli olduğunu doğrula.
5. Önce erişimi kesmeyen bağımsız bir uzaktan bağlantı/yerel kurtarma yolu doğrulanmış disposable VM'de pre-login restart/power-loss ve rollback; sonrasında Work-PC canlı kabul. Test yoksa PASS yok.

**Durum: Kaynak teslimi testli; üretim SYSTEM Hub boot hâlâ NO-GO / NOT_RUN.**
