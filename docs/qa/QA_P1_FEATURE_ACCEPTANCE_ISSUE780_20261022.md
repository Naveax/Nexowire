# Nexowire #780 | P1 Kodlama Ürünü Özellik Kabul Listesi

**Tarih:** 22 Ekim 2026 · **Kaynak:** [P1 ürün epic #780](https://github.com/Naveax/Nexowire/issues/780) · **Ana dal:** `754cc4364822be5fda528f54042fb22a84f19924`.

**Kapsam:** Bağımsız P1 ürün kabulü, R01–R22 P0 güvenlik kabulünden *ayrı*. Bu sayfa bir özellik envanteri veya uygulamanın tamamlandığı iddiası değildir. Kaynak envanteri ve spesifik uygulama kanıtı henüz bu #16 denetimi kapsamında **NOT_TESTED**. Her bir özellik için source, staging ve production kapıları ayrıca ispatlanmalıdır. Herhangi bir P1 özelliği, #271/#551/#587/#588/#617 veya R01–R22 P0 testlerini gevşetemez.

## P1-A: Özellik kabulü (MVP)

### P1-INV | Kaynak envanteri ve gap haritası
- [ ] **Source:** Mevcut Git/worktree, diff, transfer, device worker, journaling, WebSocket reconnect, checkpoint, browser ve sandbox modülleri gerçek commit SHA ve sembol/test yoluyla envanterlenmiş; olmayan bir özelliğe “var” denmiyor.
- [ ] **Negative:** Tarihsel dal yeşili, aynı commit üzerinde doğrulanmamış özellik, yalnız UI etiketi veya doküman vaadi kabul edilmiyor.
- [ ] **Staging / Production:** Ürün sahibi, özellik ve yetki sınırı belli olmadan ACCEPTED yok.
- **Durum:** NOT_TESTED. Envanter ilk bağımlılık; boşluğu tahmin ederek kod yeniden yazılmayacak.

### P1-DIFF | Diff önizleme, onay, uygulama ve geri alma
- [ ] **Source:** İzole Git worktree'de base commit SHA, hedef owner/device/task/grant, dosya ve gerçek handle/path kapsamı bağlı unified diff üretilir. Preview → approve/reject → apply aşamaları farklı, audit edilmiş durumlardır. Stale base/HEAD veya değişmiş ownerEpoch ile uygulama fail-closed.
- [ ] **Source:** Apply sonrası hash/status readback; reject hiç yan etki üretmez. Rollback yalnız mevcut doğrulanmış Git commit/snapshot üzerinden, korunan yolların hariç tutulduğu kapsamda ve yan etki sınıfı uygun olduğunda mümkündür. Dosya dışı komut/VM/uzak mutasyon “tek tık geri alındı” diye sunulmaz.
- [ ] **Negative:** Yanlış SHA, çakışan diff, forged approval, revoked owner, symlink/junction/path escape, crash-after-write, disk full, lost ACK ve `MUTATION_STATE_UNKNOWN` için **reconcile required**, kör replay/rollback yok.
- [ ] **Staging:** Disposable worktree'de orijinal içerik/hash korunumu, yeniden başlatma ve iki sahip çatışması gösterilir.
- [ ] **Production:** İmzalı owner grant ve gerçek postcondition ispat edilmedikçe kapalı.
- **Durum:** NOT_TESTED. P0 #587 ve #588'den bağımsız başarı ilan edilemez.

### P1-SANDBOX | Göreve özel çalışma alanı ve OS izolasyonu
- [ ] **Source:** Task'a bağlı root ve root-relative path/volume/file-ID kimliği; dış dizin için ayrı açık grant; symlink/junction/ADS/rename/ancestor ACL ve import/updater kontrolleri.
- [ ] **Source:** Process, network, Git hooks ve environment secrets sınırı açık OS izolasyon mekanizmasıyla doğrulanır. Sadece pathname kontrolü **process sandbox değildir**. Windows Job/AppContainer/VM, Linux namespace/container ve macOS için ayrı capability/UNAVAILABLE davranışı vardır.
- [ ] **Negative:** Root escape, unsigned hook, inherited low-trust Modify, forged grant, child process escalation, secret exposure ve sandbox yokken “safe” iddiası fail-closed. Signed HIGH Broker otomatik olarak sandbox içine gizlenmez veya sandbox onayıyla çalıştırılmaz.
- [ ] **Staging:** İzole disposable task, farklı owner/cihaz ve yanlış OS için bağımsız containment testleri; stdout/stderr/exited ve timeout sıralaması.
- [ ] **Production:** #271 etkin ACL ve #551 signed bootstrap fiziksel kabulünden önce yüksek yetki kapalı.
- **Durum:** NOT_TESTED.

### P1-LOOP | Deterministik ve sınırlı ajan döngüsü
- [ ] **Source:** Plan → tool → observe → test/fix → stop aşamaları state machine ile tanımlı; istemci veya ince device worker'ın tek taskId/requestId/ownerEpoch/grant-generation bağlamı vardır.
- [ ] **Source:** Maksimum adım, süre, token, kota, iş sayısı ve cancellation; her yan etkinin değişmez makbuzu ve audit izi. Revoke/re-pair sonrası eski owner işe dönemez.
- [ ] **Negative:** Half-written source, test RED, lost ACK, stale epoch, forged receipt, iki worker race, network kesintisi ve quota exhaustion; olası mutasyonda **MUTATION_STATE_UNKNOWN → RECONCILE_REQUIRED**, aynı mutasyon otomatik replay edilmez, COMPLETED kanıtsız verilmez.
- [ ] **Staging:** Çift worker / iki Hub yarışları, bağımsız readback, restart, crash ve bounded stop tests.
- [ ] **Production:** P0 gerçek atomic dispatch-authority ve publisher witness olmadan unsafe/elevated loop OFF.
- **Durum:** NOT_TESTED.

### P1-CKPT | Kalıcı checkpoint ve bağlam sıkıştırma
- [ ] **Source:** Versioned checkpoint; task graph/step, dosya SHA, diff/base, CI run IDs, cihaz kimliği/owner epoch/grant, test durumu, quota, pending UNKNOWN ve güvenli bir sonraki eylem eksiksiz. HAM token/secret/redacted contents saklanmaz.
- [ ] **Source:** Owner/device scoped authenticated encryption, schema migrasyonu ve durable fsync/atomic replacement; resume öncesi authority, current source HEAD, dosya hash ve bağımsız yan etki durumu tekrar doğrulanır.
- [ ] **Negative:** Eski/forged checkpoint, rollback snapshot, cross-owner restore, changed HEAD, missing file, untrusted summary, truncated/damaged checkpoint, revoked grant ve possible-effect UNKNOWN, unsafe automatic resume'a yol açmaz.
- [ ] **Staging:** Process restart, chat context limit, concurrent checkpoint writer ve iki cihazlı doğrulanabilir resume testleri.
- [ ] **Production:** P0 #587 ve #588 fiziksel doğrulama olmadıkça native mutation güvenli tamamlandı diye işaretlenmez.
- **Durum:** NOT_TESTED.

## P1-B: İkinci kademe ürün ergonomisi
- [ ] Git.status/diff/commit/worktree ve PR/review entegrasyonu; stale SHA / merge-base kayması fail-closed. **NOT_TESTED**
- [ ] before_mutation / after_shell / on_failure hook zinciri; timeout + audit, hooks güvenlik sınırını bypass edemez. **NOT_TESTED**
- [ ] Alt ajanlar için bağımsız requestId/session/owner, bounded quota ve otomatik HIGH devri yasağı. **NOT_TESTED**
- [ ] Mevcut CDP üzerinde navigate/wait/assert/screenshot; gerçek capture yoksa PASS iddiası yok. **NOT_TESTED**
- [ ] Audit paneli: gerçek signed Broker readiness, capability, deny/UNKNOWN, zaman kaynaklı ölçüler; sır/token sızıntısı yok. **NOT_TESTED**

## Kabul kapıları ayrımı

| Kapı | Şu an | Geçiş için gerekli kanıt |
|---|---|---|
| R01–R22 P0 source | 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED | Her requirement kendi kaynak regresyonuna göre |
| P0 staging / production / incident | 22/22 BLOCKED | #271, #551, #587, #588, #617 fiziksel yetki ve postcondition |
| P1 özellik source (INV/DIFF/SANDBOX/LOOP/CKPT) | NOT_TESTED | Gerçek repo envanteri + özgün fixture/negative exact-head CI |
| P1 staging / production | BLOCKED | Kapsamlı OS/owner/revoke/restart/rollback acceptance ve P0 güvenlik onayı |
| #780 issue | OPEN P1 EPIC | PR değildir; kendi başına CI başarısı veya P0 regresyonu değildir |

**Kesin kural:** Bağımsız QA P1 prototipi test geçse bile CORE/HIGH veya Hyper-V yükseltilmiş yetkiyi otomatik açamaz. Yalnızca ilgili gerçek P0 yetkileri, imzalı kurulum, atomik external CAS ve fiziksel native readback ayrı kabul edilirse güvenli geçiş tartışılabilir.

**Canlı işlem:** Yok. ReVoltVPN-Ubuntu-Lab, Agent, UAC, ACL, VM ve gerçek DB/Cloudflare state dokunulmadı.
