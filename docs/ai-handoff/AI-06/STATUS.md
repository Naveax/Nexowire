# AI-06 | Durum

**Durum:** IN_PROGRESS (source-only), **Production CORE: NO-GO**.

- Repo: `Naveax/Nexowire`; branch `ai/06-console-claim`; Draft PR #985.
- Base exact SHA: `7e4093c30c1ead3cd22888184450c34aef4737da` (#980).
- Son tüm job'ları PASS olan exact HEAD: `790e83ba757ecc928b7af1d8fe4ac0cc389587ea`, CI `41201296965` (7/7), Node22/24 2770 test / 2416 PASS / 0 FAIL / 352 SKIP / 2 TODO; 31/31 AI-06.
- Bu kaynak değişikliği: geç STOP/abort + native callback öncesi iptal yeniden kontrolü, owner/credential claim re-pair negatifleri ve owner-status platform/readiness/revoke yarışları.
- Güncellenen kaynak/test commit'inin exact HEAD ve CI sonuçları PR üzerinden ayrıca doğrulanacak; eski HEAD PASS sonucu yeni HEAD'e aktarılmayacak.
- CI queued/in_progress ise yeniden dispatch yok, aynı run ID takip edilir.
- Ortak dosyalar, `main`, başka ajan branch'i, migration ve canlı cihaz değişmedi. 
- **Açık P0:** `claim` henüz native readback onayı yokken `dispatched` durumuna geçiyor; `complete(succeeded)` bununla yarışabiliyor. Migration / approval-marker koordinatörde, `INTEGRATION_REQUEST.md` üzerinden talep edildi.
- Sıradaki kapılar: yeni SHA'nın CI/Windows sonuçları, AI-08 bağımsız QA, gerçek protected native effect boundary ve iki Windows PC fiziksel kabulü.

## Controller-level revoke / enroll nesil-fence

`CoreConsoleAdmission.enroll` native provider yanıtı beklerken `revoke` gelirse,
`revokeSequence` uyuşmazlığı ile STOP'un geri açılması reddedilir. Sadece
STOP sonrasında **yeniden başlatılan** açık yerel enrollment iş akışı
controller durumunu sıfırlayabilir. İki revoked-race (revoke ACK başarı/kayıp)
ve bir explicit-enroll kontrolü yeni `test/ai06-consent-controller-races.test.ts`
ile test edilecek; yeni exact HEAD CI sonucuna kadar PASS sayılmaz.
