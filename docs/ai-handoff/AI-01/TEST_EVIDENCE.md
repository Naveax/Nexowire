# AI-01 | TEST_EVIDENCE

## Baz / sınır
- Repo: `Naveax/Nexowire`, base `main` `a19a228dc6f19fd484cf935e941a00ea625233f8`.
- Test edilen kaynak HEAD: `f33bc494fe4efe2a75d5a4a91917661afba8fa4b`. Draft PR #986, `ai/01-wal-v108`.
- Kaynak değişikliği: yalnız `src/agent/operation-journal-wal.ts`; yeni `test/ai01-wal-snapshot-races.test.ts`; AI-01 handoff klasörü. Başka testleri/ortak dosyaları değiştirmedik.
- Kullanıcıya ait gerçek journal/Agent/credential UAC/ACL/DPAPI ya da iki-PC fiziksel kabul testi **yapılmadı**. Tüm DB örnekleri izole, sentetik ve SQLite tarafından üretildi.

## Testler ve kanıt
- [CI run 41197139627](https://github.com/Naveax/Nexowire/actions/runs/41197139627), exact SHA `f33bc494fe4efe2a75d5a4a91917661afba8fa4b`, workflow `CI`, **tamamlandı: SUCCESS (7/7 job)**. İlk attempt 6/7, `browser-live` FAIL; sadece başarısız job aynı run ID içinde bir kez yeniden çalıştırıldı ve **SUCCESS**. Birincil başarısızlık korunarak raporlanır, gizlenmez.
- Node 24 Ubuntu `test (24)`: `npm ci`, `npm run check`, `npm run build` job SUCCESS; Node test özeti **2.335 test / 2.043 PASS / 0 FAIL / 292 SKIP / 0 TODO**. Test logunda `checksum-valid current WAL with a missing final commit marker fails closed` **PASS**.
- Node 22 Ubuntu `test (22)`: aynı iş dizisi SUCCESS; son commit-sınırı negatif testi logda `ok`.
- Windows GitHub-hosted runner `browser-live` (tekrar koşu): `npm run typecheck` **SUCCESS**; `node --test --import tsx --test-concurrency=1 test/qa-journal-wal-recycle-p11.test.ts test/agent-operation-wal-integrity.test.ts test/agent-journal-restart-regression.test.ts test/native-agent-startup-diagnostic.test.ts` **SUCCESS**; update startup/rollback, CORE-console ve diğer Windows runner kontrolleri SUCCESS. Bu, **GitHub Windows runner** kanıtıdır; kayıtlı NAVEAX/Work-PC üzerinde fiziksel kabul değildir.
- Eski 1.0.8 kaynak fixture'ı `test/agent-journal-restart-regression.test.ts`: SQLite-autentik 709 current / 295 old frame, 473 commit ve 1.307 sentetik işlem satırı; 6 crash/restart + 1 temiz restart; UNKNOWN tombstone ve duplicate request ID reddi. Shared/diğer sahip dosyaları AI-01 düzenlemedi.
- AI-01 izole test dosyası: **12 ayrı test**. Hot/recycled/empty WAL olumlu; late WAL header ve SHM değişimi, POSIX inode swap (byte-identical dahil), current salt, kesik ve kısmi frame, terminal commit marker yok ama checksum-valid suffix negatif; SQLite reopen UNKNOWN ve duplicate-ID korunması. POSIX rename testleri Windows'ta platform gereği açıkça SKIP; bunlar fiziksel Windows PASS sayılmaz.

## İlk Windows RED: nedeni ve yeniden doğrulama
- `41197139627` ilk attempt, `browser-live` job `124525654463`, `Verify recycled WAL and consecutive journal process restarts`: mevcut `#974 current-salt damage ...` testinin `child()` IPC cevabı 30 saniyede gelmedi; stderr boş, `test/agent-journal-restart-regression.test.ts:44`; 32 testten 30 PASS, 1 FAIL, 1 SKIP.
- Aynı testin doğrudan `verifyAgentJournalWal()` negatif reddi bu ilk attempt'te de PASS. Hatanın hangi child yaşam döngüsü koşulundan kaynaklandığı yalnız bu logla kesin saptanmadı; false-PASS denmedi ve timeout/test beklentisi gevşetilmedi.
- Terminal FAIL sonrası yalnız başarısız `browser-live` job yeniden denendi. Retry job `124526485719`: WAL/restart adımı, Windows tip kontrolü ve tüm workflow **SUCCESS**. Yeniden çalıştırma yeni workflow dispatch'i değildir; ilk attempt'in hatası tarihsel kanıttır.

## Sınırlar ve önceki koşular
- `41194627316`: önceki `0f48b9...` HEAD'te TS2532 typecheck FAIL (düzeltildi). `41194708825`: `236b215...` HEAD'te CANCELLED. `41194972463`: `57791204...` HEAD'te 7/7 SUCCESS. `41196318562`: `8e44c3...` HEAD'te kaynak testleri geçti; sonraki push sebebiyle workflow CANCELLED, tam PASS sayılmaz.
- Bu runtime'da authenticated GitHub connector aracılığıyla commit/diff/CI doğrulandı. Yerel clone ve tam `git status`, `npm ci`, `npm run typecheck`, `npm run build` çalıştırılmış gibi gösterilmiyor.
- Bu doküman değişikliği için yeni exact HEAD CI sonucunu **ayrı doğrula**; son başarılı kaynak SHA'sını yeni HEAD'e otomatik aktarma.
