# AI-08 | Entegrasyon ve kanıt talepleri (doğrudan değişiklik YOK)

## #03 / #07: gerçek sandbox
`task-os-sandbox-capability.ts` şu an native sandbox kurmuyor ve Agent dispatch'e entegre değil. #03 sahibi her `shell.exec`, `wsl.exec`, `process.start`, `task.graph.run`, `runbook.run`, `workspace.checks`, `workspace.snapshot` için başlamadan önce doğrulanabilir native provider admission + deny-on-UNKNOWN arayüzü sunmalı; #07 sahibi düşük yetkili token, handle/env inheritance, breakaway+descendant, file/network/IPC ve revoke cleanup ölçümünü vermeli. Bu QA branch'i source değiştirmez.

## #04 / verifier: fiziksel enrollment
Sentetik imzalı session proof veya loopback TLS sonucu kalıcı/gerçek UAC fiziksel kanıt değildir. Windows service identity, machine-bound DPAPI/TPM, gerçek owner SID, revoke/re-pair, logon/reboot/sleep ve machine pin için bağımsız native readback artefaktları ve iki yetkili cihazda owner-approved acceptance gerekir. CORE production durumunu açık tutmayın.

## WAL / journal
#974 açısından 1.0.8 kaynak ve canary yayın kanıtı, tüm Windows 10/11 + iki PC + sleep/interruption + 24h koşullarını karşılamaz. Dönüşüm sırasında aynı UNKNOWN/tombstone ve journal içerikleri korunmalı; gerçek SQLite dosyaları veya kullanıcı kimliği QA'ya taşınmamalı.

## #01 / #02 / #04
CAS tombstone'nin broker restart/failover/lost ACK altında kalıcılığı; privileged receipt native token doğrulaması; D1 claim sonrası platform/owner/readiness TOCTOU; native secure desktop input boundary ve revoke drain: ilgili modül sahipleri fiziksel/staging probe ve exact-SHA evidence sağlamalı. AI-08 yalnız QA/handoff üretir.

## Koordinatör
Mevcut `npm test` / CI matrisi testleri otomatik keşfetmiyorsa değişikliği yalnız koordinatör üstlenir. AI-08 `.github/workflows/**`, `package*.json` veya `src/**` değiştiremez.


## 31 Ekim 2026 bağımsız koordinasyon notu
AI-08 `9feb149e1b2723bb4609d21e4167824e400e9b85` kaynağında 32 yeni negatif PASS bulunur; bu testler **#984 bazında** yürüdü. AI-01 #986 WAL path/header TOCTOU, AI-03 #988 mTLS response parsing, AI-04 #987 Broker readback snapshot, AI-05 #992 CAS scoped reservation, AI-06 #985 D1 signing-key rotation ve AI-07 #990 sandbox hostile-reflection değişiklikleri kendi Draft HEAD'lerindedir. Bu PR'ların **başarı sonuçları birbirinin combined runtime'ı değildir**. Koordinatör bunları doğru bağımlılık sırasıyla ayrı entegrasyon HEAD'inde birleştirip 32 AI-08 negatif ile Node22/24 + Windows/source CI'ı yeniden çalıştırmalıdır; tarihsel RED kayıtları korunmalıdır.

Son AI-08 ek testleri yalnızca kaynakta DB owner/grant/revoke ve Windows logon scope race'lerini doğrular. D1 claim sonrası gerçek OS effect boundary, signer public-key change (#985), broker native HIGH token readback, gerçek multi-process CAS failover/replay, kernel handle-env-child-network izolasyonu ve rollback/24h fiziksel kabul AI-08 üzerinde **kanıtlanmadı**. Bunlar kaynak sahiplerine ve owner test ortamına açık handoff olarak kalır. Testi skip/gevşetmek bu engelleri kapatmaz.


## 31.10.2026 için owner-PR entegrasyon sınırı
AI-08'nin #984 tabanında çalıştırdığı önceki 32 sentetik negatif, AI-01 #986, AI-03 #988, AI-04 #987, AI-05 #992, AI-06 #985, AI-07 #990 üzerinde sonradan değişen `src/**` ve `native/**` dosyalarını otomatik olarak kapsamaz. Koordinatör bu exact HEAD'leri doğru bağımlılık grafiğiyle **tek yeni isolated integration SHA** üzerinde test etmeli; owner PR'ların aktif `browser-live` run'larına aynı SHA'da duplicate dispatch yapılmamalı. Gerçek owner-approved Windows kernel/session ve iki-PC, 24h sleep/reboot provası ile native sandbox file/network/handle/child/revoke-drain kabulü açık `BLOCKED` kapılarıdır.
