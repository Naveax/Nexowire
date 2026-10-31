# AI-08 | STATUS

**Durum:** `REVIEW` kaynak düzeyinde, OS/physical kabul `BLOCKED`; **CORE production NO_GO**.

**Branch:** `ai/08-independent-qa-20261031`  
**Draft PR:** https://github.com/Naveax/Nexowire/pull/989  
**Base:** `local/persistent-enrollment-v2-20261031` #984 `9d0f35607d4cde87bd031e2da77855cfaf570c31`  
**Test-kodu HEAD:** `9feb149e1b2723bb4609d21e4167824e400e9b85`  
**Bu raporun git commit SHA'sı:** PR HEAD üzerinden ayrıca okunur; kendinden sonraki SHA'yı dosyada uydurmayın.  
**Test kodu CI:** https://github.com/Naveax/Nexowire/actions/runs/41196966679

## Ölçülmüş source QA
- Node 22: job `124525116348` SUCCESS, AI-08 **32/32 PASS**, genel 2802/2446 PASS/0 FAIL/354 SKIP/2 TODO.
- Node 24: job `124525116481` SUCCESS, AI-08 **32/32 PASS**, aynı genel sayılar.
- Typecheck, test, build: iki Node job'ında SUCCESS, exit 0.
- Windows `browser-live`: son sorguda **in_progress**, tüm workflow PASS iddiası henüz yok. Yeni docs HEAD kendi CI kanıtını gerektirir.

## Kapsam ve sıradaki kapılar
Altı AI-08 test dosyasında WAL restart/recycle, bozuk WAL/SHM, credential/owner/session, mTLS SPKI pin, signed receipt/ACK loss, CAS immutable scope, D1 claim race (15 durum), sandbox fake-proofs/UNKNOWN ele alınır. Bu kaynak testleri gerçek cihaz yetki kanıtı değildir.

Koordinatör, onaylı AI-01...AI-07 deltasını ayrı birleşik HEAD'de test etmelidir; #989 bunları otomatik içermez. Gerçek Windows low-privilege worker, handle/env/child/network/IPC containment, native UAC/SID/DPAPI readback, external CAS durability, iki-PC restart/sleep/24h acceptance: **BLOCKED**. Merge/deploy/live Agent yapılmadı.
