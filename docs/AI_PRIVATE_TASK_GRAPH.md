# Nexowire AI özel masaüstü | Task Graph yönlendirme

`task_run_graph` isteği `ui_target: "private_desktop"` seçeneğini
destekler. Böylece bağımlılıkları olan çok adımlı terminal/komut
görevlerinin her yürütme adımı, daha önce #401 ile doğrulanan
`NexowirePrivate` Windows masaüstü içinde başlatılır. Çıktı, çıkış
kodu, timeout, stop_on_failure, artifact ve bağımlılık semantiği
değişmez. Özel hedef kullanılırken başarısız masaüstü başlatılması
kullanıcının `Default` masaüstünde komut yürütmeye geri dönmez.

Var olan `headless` varsayılanı geriye uyumluluk için korunmuştur.
Kaydedilen bir Task Graph planı özel `ui_target` seçimini plan
hash'ine dahil eder; önceden kaydedilmiş headless planların hash'i
değişmez. Bu, yarıda kesilen görevleri farklı masaüstü hedefinde
sessizce yeniden yürütmeyi önler.

Windows DEV canlı testi iki bağımlı PowerShell görevinin çıktısını
başarıyla toplar; `Default` aktif input desktop olarak kalır.
Normal CI fiziksel kullanıcı ekranı veya GUI başlangıcı gerektirmez;
özel etkileşimli test `NEXOWIRE_RUN_PRIVATE_GRAPH_LIVE=1`
ile ayrı kabul edilir.

## Tamamlanmamış

`workspace.checks`, installer, GUI browser automation,
`ShellExecute`/Explorer üzerinden dolaylı başlatma ve ekran
viewer/bildirim akışı hâlâ #402 kapsamındadır. Özel Win32
masaüstü, ikinci donanımsal ekran ya da Windows Win+Tab sanal
masaüstü değildir. Üretim geçişi #271 ve kullanıcı onayına
bağlıdır; bu yalnız kaynak geliştirmesidir.
