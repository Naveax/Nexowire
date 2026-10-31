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
