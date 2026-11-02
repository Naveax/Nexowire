# Nexowire | Tek Durum ve Entegrasyon Panosu

## 0A. Canlı kaynak/PR/kurulu sürüm uzlaştırması (2 Kasım 2026)

Bu matris dört farklı kanıtı **birbirinin yerine koymadan** takip eder: (1) `main` kaynak commit'i, (2) açık stacked/Draft PR değişikliği, (3) exact-SHA CI ve güvenlik negatifleri, (4) kurulu iki Windows cihazında **gerçek operasyon**. Kaynakta merged, cihazda kurulu demek değildir. CI green de üretim CORE onayı değildir.

| Hat | Main veya üst branch | Ayrı PR ve exact CI | Gerçek cihazdaki kanıt | Karar ve tamamlanma koşulu |
| --- | --- | --- | --- | --- |
| **Agent WAL P0 #974** | `main` içinde merged **#986** (daha eski #957/#978 adaylarını yeniden aktarma) | Superseded Draft **#1008 closed/unmerged**; içeriği #986 + #1002 ile main'e ayrı alındı | NAVEAX çalışıyor; son durumda DB 638976 B, `-wal` 0 B, `-shm` 32768 B; bu tek başına WAL recycle kabulü değildir | 1307 kayıt/UNKNOWN bütünlüğü + gerçek yeniden kullanım + imzalı kurulum/Windows reboot kabulü olmadan **OPEN** |
| **Journal sahibi ve komut P0 #1001** | `main` içinde **#1002** PID+OS birth, **#1009** init serialize; yeni lease için kaynak çözümü var | Stacked **#1005** kaynak entegrasyonu CI **41247503706 7/7 SUCCESS**; CORE parent #980'e bağlı ve fiziksel kabul değil | NAVEAX `agent_operation_owner.pid=2268,process_identity=NULL`; güncel PID 2268 `svchost.exe` (BFE/mpssvc), Agent Node PID 16380. Agent online ancak ilk `shell.exec` `AGENT_JOURNAL_IN_USE`; **V2 AUDIT_PARTIAL**, onarım uygulanmadı | Eski NULL kimlikli lease için fail-closed, atomik, bağımsız testli offline migration; `UNKNOWN` ve DB/WAL/SHM korunacak; gerçek uzaktan harmless execution + reboot testi |
| **Windows süreç yaşam döngüsü #540** | #1043 native Job yardımcı derleme düzeltmesi `main` içinde | **Draft #1047** exact head `25402d3`, CI **41404627754 7/7 SUCCESS**; 129+/150 sentetik makbuz/retention | Daha önce Scheduled Task stop sonrası Agent Node orphan kalmış; canlı/VM 129+ stop/restart ve PID-birth/guardian acceptance yok | #1047 için izole Windows fiziksel görev testi; ardından reviewed merge; rastgele PID/Windows servisi durdurma yok |
| **Windows rollback/handoff QA** | Mevcut `main` suite, eski gerçek Windows testlerinde 27 FAIL | **Draft #1048** exact head `803abc3`, CI **41403326382 7/7 SUCCESS**; test fixture `...process.env` üretim `isolatedMachineUpdateChildEnvironment()` ile eşdeğer değil | Üretim-eşdeğer rollback testi ve bütün Windows suite henüz PASS değil | Testleri gevşetmeden prod-env eşdeğerliği ve geriye kalan hataları sınıflandır |
| **CORE fiziksel yönetim** | **Draft #980** 144 dosyalı parent eski pre-WAL `main` tabanında; CI **41113730982 7/7** yalnız kendi SHA'sı | **#985** native-verified claim runtime CI **41249331481 7/7**; **#996** D1 migration CI **41246389410 7/7**; **#989** bağımsız QA CI **41250968587 RED**. **#1005** jurnal/CAS composition ve **#982** mTLS kendi branch'lerinde GREEN, aynı final commit değil | NAVEAX `LOCAL_ENROLLMENT_REQUIRED` (`localEnrolled=false`); Work-PC `CURRENT_AUTHORITY_UNAVAILABLE` (`localEnrolled=false`); ikisi de `active=false` | **NO-GO**: eski parent'ı körlemesine merge/rebase etme; #980 + #985 + #996 + #989 + #1005 aynı isolated HEAD üzerinde test edilmeli. #989 Node24 dört P0 başarısız: erken `complete(succeeded)`, dispatched->reserved, UNKNOWN->reserved, immutable scope ihlali. Gerçek Win32 izin/effect readback sonra |
| **Connection v2 Cloudflare** | `main`e alınmadı | **Draft #1003** exact head `30a9053`, CI **41246756343 6/7 RED**; bağımsız **Draft #1044** CI **41402284467 RED** | İki PC online olması Cloudflare credential veya Connection v2 security kabulü değildir | Binary TOCTOU, publisher signature, HTTPS URL/redirect/private, credential DACL/ACL ve task child cleanup P1'leri çözülmeden **NO-GO** |
| **Entegrasyon panosu #1049** | Sadece `docs/PROJECT_STATUS.md` | Önceki exact HEAD `f9269ff`, run **41425279275 6/7 RED**: Windows `#974 index-copy damage` worker 30 saniyelik timeout; doküman kaynak değişikliği değil | Bu test sonucu gerçek PC WAL corruption kanıtı değil | Yeni HEAD exact CI 7/7 olmadıkça doc-only PR bile merge edilmeyecek |

**Tekrarlanmayacak işler:** merged #986/#1002/#1009/#1043 için aynı kodu yeniden geliştirmeyin; kapalı ama **merge edilmemiş** #1008'i ikinci kez açmayın. #989 güvenlik negatiflerini kırmızıdan yeşile çevirmek için kaldırmayın, #1044'ün P1 testlerini skip etmeyin. Kaynak değişikliği > kurulu imzalı paket > iki-PC gerçek sağlık/restart kanıtı sırasını koruyun.

**Şimdi owner sırası:** (1) #1001 legacy lease offline/VM migration + NAVEAX mutasyon geri kazanımı; (2) #1047 Task Guardian Windows fiziksel kabulü ve #540; (3) #1048 test/prod-env eşdeğerliği; (4) #980/#985/#996/#989/#1005 tek SHA güvenlik kombinasyonu; (5) #1003/#1044 P1 closure. Üretim journal, Windows firewall BFE/mpssvc, token, UAC, CORE grant veya canlı restart üzerinde otomatik işlem **yapılmadı**.

## 0. 2 Kasım 2026 entegrasyon kontrol noktası

> **Bu bölüm en son kaynak/CI kontrolüdür.** Aşağıdaki **1 Kasım envanteri tarihsel snapshot** olarak korunmuştur. Branch/PR sayıları canlı sayaç değildir; karar öncesi GitHub'dan yeniden doğrulayın. Son bilinen ana dal: `a1e6af80413e866da654889b583c3cd41fa596e9`.

| Durum | İş | Kanıt / kabul sınırı |
| --- | --- | --- |
| **YAPILDI (main source)** | [#1042](https://github.com/Naveax/Nexowire/pull/1042) tek durum panosu ve SHA-bağlı envanter | 7/7 exact-HEAD CI; snapshot 1 Kasım, canlı sayı değil |
| **YAPILDI (main source)** | [#1043](https://github.com/Naveax/Nexowire/pull/1043) MSVC/Windows Job helper build fallback | 7/7 exact-HEAD CI ve NAVEAX PS5.1/PS7 yerel derleme; **Scheduled Task child-stop #540 ayrı açık** |
| **YAPILDI (main source)** | [#1045](https://github.com/Naveax/Nexowire/pull/1045) Windows browser-live 75 dakika job üst sınırı | 7/7 CI; DPAPI 15 dakika ve negatifler korunur; sorun giderilmiş üretim kabulü değil |
| **YAPILDI (dokümantasyon)** | [#1046](https://github.com/Naveax/Nexowire/pull/1046) AI-12 2 Kasım DAG arşivi; [#861](https://github.com/Naveax/Nexowire/pull/861) 24 Ekim QA11 arşivi | Her ikisi exact-HEAD 7/7; tarihli kayıt, current GO değil |
| **TESTLER GEÇTİ / KABUL BEKLİYOR (Draft)** | [#1048](https://github.com/Naveax/Nexowire/pull/1048) AI-10 Windows rollback/handoff fikstürü | Exact HEAD `803abc342cf2fb99abf0fd18341892ba2c890e7f`, run **41403326382 7/7 SUCCESS**; Windows Node 22/24 + PowerShell 5.1 odaklı testler PASS. Ancak fixture `...process.env` kullanıyor; gerçek updater `isolatedMachineUpdateChildEnvironment()` daha dar: **prod-env eşdeğerliği kanıtlanmadan merge/production GO yok** |
| **TESTLER GEÇTİ / KABUL BEKLİYOR (Draft)** | [#1047](https://github.com/Naveax/Nexowire/pull/1047) AI-09 Agent Job owner | Exact HEAD `25402d369a0e25d8f9507e1c7ddb761581ec4123`, run **41404627754 7/7 SUCCESS**. 150 çevrim **sentetik**, gerçek Windows 129+ Task stop/start, PID reuse/access denied, orphan/unclaimed guardian, dosya kimliği yarışları ve uninstall kabulü hâlâ gerekli; #540 açık |
| **BLOKE (Draft)** | [#1044](https://github.com/Naveax/Nexowire/pull/1044) AI-11 bağımsız güvenlik negatifleri / ürün [#1003](https://github.com/Naveax/Nexowire/pull/1003) | Binary TOCTOU, publisher, control-plane URL/redirect ve credential ACL eksikleri; test RED **kapatılmayacak**, CORE/Connection production **NO-GO** |
| **P0 AÇIK / CANLI KANIT** | [#1001](https://github.com/Naveax/Nexowire/issues/1001) legacy `process_identity=NULL` + yeni boot'ta PID 2268=`svchost.exe` | Agent bağlanıyor ancak ilk mutasyonda `AGENT_JOURNAL_IN_USE`; fail-closed korunmalı, OS-kimlik doğrulamalı eski lease migration ve VM reboot regresyonu gerekiyor |
| **P0 AÇIK** | [#974](https://github.com/Naveax/Nexowire/issues/974) WAL, [#1001](https://github.com/Naveax/Nexowire/issues/1001) Agent journal, [#540](https://github.com/Naveax/Nexowire/issues/540) Task descendants | Signed installed Windows crash/reboot + independent Hub/VM kabulü henüz kanıtlanmadı |

**Canlı cihaz ve sahiplik denetimi (2 Kasım 2026):** Nexowire'ın **kendi native-agent bağlantısında** NAVEAX ve Work-PC `online`; NAVEAX Native Agent / Privileged Broker görevleri `Running`. Ayrı Remote Desktop Commander bağlantısı **Offline**. NAVEAX Agent `1.0.8-localfix-4d699b8`, Work-PC Agent ise eski `1.0.8-a19a228dc6f1` runtime'ında; kaynak düzeltmesi iki kurulu PC'ye otomatik geçmedi. NAVEAX salt-okunur SQLite sahiplik kaydı `agent_operation_owner(pid=2268, process_identity=NULL)`; **şu anki PID 2268 Windows `svchost.exe`**, 2 Kasım 09:17:40 yerel saatte başlamış, Agent PID 16380 ise Node. Bu, eski PID'nin yeniden açılışta ilişkisiz bir sürece tahsis edilmesiyle aynı gözlemdir: Agent `local-state-ready`/online, fakat ilk mutasyon `AGENT_JOURNAL_IN_USE` ile reddediliyor. Kanıt ve güvenli migration kabul koşulları [#1001](https://github.com/Naveax/Nexowire/issues/1001)'de. **`svchost.exe` kapatılmayacak; SQLite lease/UNKNOWN/WAL/SHM silinmeyecek ya da elle resetlenmeyecek.** Gerçek PC reboot, CORE/UAC/ACL/token veya deployment değişikliği **yok**. İzole VM reset çıkış kodu, VM içinde kurulu Agent PASS değildir.

---

> **Tarihsel envanter snapshot'ı: 1 Kasım 2026.** Kaynak: canlı GitHub API + tam Git geçmişi. Main snapshot: **4d699b8bbd8cb908c782a3776a34301c4a4c74b5**. Bu bir iş ve kanıt günlüğüdür; tek başına release, CORE veya fiziksel cihaz GO belgesi değildir.

**Başlangıç noktası burası.** [ROADMAP](../ROADMAP.md), [30 Ekim entegrasyon günlüğü](BRANCH_INTEGRATION_BATCH_20261030.md) ve [eski branch kataloğu](BRANCH_CATALOG.md) tarihsel kayıt olarak kalır. Bu sayfada yeni durum ayrımı kullanılır.

## 1. 1 Kasım tarihli envanter snapshot'ı

| Ölçüt | Sayı |
| --- | ---: |
| Açık PR, tamamı Draft | **368** |
| Doğrudan main'e hedeflenen PR | **87** |
| Başka branch üzerine stacked PR | **281** |
| Uzak branch (2 eski dal silindikten sonra) | **397** |
| Commit geçmişiyle main içinde olduğu kanıtlanan dal (main dahil) | **9** |
| Açık PR head/base bağı olmayan benzersiz commit taşıyan dal | **53** |
| Bu tur silinen doğrulanmış eski main-ancestor dalı | **2** |

Bütün dallar: [branch SHA, ahead/behind, açık PR bağı, risk ve karar](inventory/BRANCHES_2026-11-01.csv). Bütün açık PR'lar: [368 PR, kaynak SHA, hedef ve başlık](inventory/OPEN_PRS_2026-11-01.csv). Bunlar salt-okunur snapshot verileridir; işlemden hemen önce HEAD ve CI yeniden kontrol edilir.

## 2. YAPILDI: kanıtlanan sınırlı işler

- [x] [GitHub Release v1.0.8](https://github.com/Naveax/Nexowire/releases/tag/v1.0.8) 30 Ekim 2026 tarihinde yayımlandı. Eski v1.0.8 paketinin yeni kaynak düzeltmeleri içerdiği varsayılmaz.
- [x] Kaynak main: [#986](https://github.com/Naveax/Nexowire/pull/986) WAL reuse, [#1002](https://github.com/Naveax/Nexowire/pull/1002) PID/incarnation, [#1009](https://github.com/Naveax/Nexowire/pull/1009) eşzamanlı journal başlatma düzeltmeleri merged. Bu sadece kaynak entegrasyonudur.
- [x] Naveax Native Agent üzerinde kaynak main'den üretilen **imzasız yerel hotfix** açıldı: local-state-ready, failureCode null, hata sayısı 0. Eski runtime ve journal kanıtı korunuyor.
- [x] Naveax Privileged Broker: authenticated read-only CLI probe **READY / elevated=true / ready=true**. Task Scheduler last result **0x800710E0** ayrı incelenecek.
- [x] Node 24.22.1 ile Windows Job/process/journal hedefli test **27/27 PASS**; 128 eşzamanlı owned-Job oturum testi **PASS**.
- [x] Tam Windows kaynak testi yeniden yapıldı: **2.380 toplam / 2.317 PASS / 27 FAIL / 36 SKIP**. Raporun oluşması tamamlandı; test paketinin kabulü **tamamlanmadı**.
- [x] Yalnızca Naveax üzerinde izole Windows VMware klonu oluşturuldu. Soft/hard VM reset exit 0; VMware sonunda 0 çalışan VM. Gerçek PC yeniden başlatılmadı. Guest Nexowire kurulu/reboot kabulü **kanıtlanmadı**.
- [x] Değişiklikleri zaten main'de olan, açık PR/aktif CI bağı bulunmayan 2 eski WAL branch'i silindi: **fix/agent-wal-recycle-boundary-20261029** (88fa241d) ve **qa/11-journal-wal-recycle-20261029** (77781e4e). Tam commit'ler main geçmişinde korunuyor.
- [x] 397 branch ve 368 Draft PR için benzersiz SHA'lı, tekrar kontrol edilebilir envanter alındı.

## 3. P0: ŞİMDİ YAPILACAKLAR

| İş | Kanıt / mevcut engel | Tamamlanma ölçütü |
| --- | --- | --- |
| **P0-A: Agent yeniden başlatma ve journal** | [#974](https://github.com/Naveax/Nexowire/issues/974), [#1001](https://github.com/Naveax/Nexowire/issues/1001) | İmzalı yeni Windows sürüm, mevcut DB/WAL/SHM/UNKNOWN koruması, kurulu Agent crash/reboot ve kimlik doğrulamalı Hub readback |
| **P0-B: Windows task süreç ağacı** | [#540](https://github.com/Naveax/Nexowire/issues/540); Stop-ScheduledTask eski Node çocuğunu bırakmıştı | Parent/child ownership ve ölüm-sonrası kayıt kanıtı, yeniden başlatmada tek Agent, PID+creation-time eşleşmesi |
| **P0-C: Windows tam suite RED** | 27 fail; [#1006](https://github.com/Naveax/Nexowire/issues/1006) | 27 hatayı kök nedenlerine göre düzelt, exact-HEAD Windows Node22/24 ve gerekli Windows helper/native regresyonları PASS |
| **P0-E: VM guest test ortamı** | VMware clone reset komutları PASS, guest operations kimlik doğrulaması engeli | İzole guest Windows içinde gerçek Nexowire kurulumu, crash/reboot readback, VM sınırları dışına credential/CORE taşımadan test |

**Naveax fiziksel bilgisayarı yeniden başlatılmayacak.** Yalnızca ayrı izole VM üzerinde restart ve guest kabulü yapılabilir. Kaynak testinde gerçek host GUI/input işlemlerinin kullanılması fiziksel CORE izni anlamına gelmez.

## 4. P1: SIRADAKİ İŞLER

- [ ] **Connection Core v2:** [PR #1003](https://github.com/Naveax/Nexowire/pull/1003) Draft; Windows managed task stop/parent lifecycle CI kırmızı. Authenticated WSS/Cloudflare, revocation ve teslimat kesinleştirilmeden merge yok.
- [ ] **CORE entegrasyon:** [PR #980](https://github.com/Naveax/Nexowire/pull/980) ve aktif AI sahipli [#987](https://github.com/Naveax/Nexowire/pull/987), [#988](https://github.com/Naveax/Nexowire/pull/988), [#989](https://github.com/Naveax/Nexowire/pull/989), [#992](https://github.com/Naveax/Nexowire/pull/992). Native OS/owner, CAS, lease, imzalı receipt, fail-closed ve fiziksel approval kanıtları gerekir. **CORE NO-GO / OFF**.
- [ ] **Entegrasyon provası:** [#995](https://github.com/Naveax/Nexowire/pull/995) eski main SHA ve lineage test sonucu RED; yeni HEAD üzerinde tekrar simülasyon; eski RED'i PASS sayma.
- [ ] **Fork CI:** [#997](https://github.com/Naveax/Nexowire/pull/997), [#998](https://github.com/Naveax/Nexowire/pull/998), [#999](https://github.com/Naveax/Nexowire/pull/999), [#1000](https://github.com/Naveax/Nexowire/pull/1000) approval/action_required; workflow tetiklenmiş/aktifse SHA başına ikinci run yaratma.
- [ ] **Kurulum ve kullanıcı rehberleri:** [#1012](https://github.com/Naveax/Nexowire/pull/1012), [#1013](https://github.com/Naveax/Nexowire/pull/1013), [#1018](https://github.com/Naveax/Nexowire/pull/1018). Güncel delegated Draft'lardır; kaynak owner ve bağımsız test kontrolü olmadan doğrudan merge yok.
- [ ] **53 PR'siz branch:** özgün commit'leri ve geçmişi korunuyor; küçük faydalı değişiklikleri PR'le, kullanılmayacak olanı kanıtla işaretle, henüz silme.

## 5. Pratik iş kuyruğu ve tekilleştirme kuralları

1. Kaynak PR durumunu **ÖNERİ / DRAFT / CI RED / CI GREEN / MAIN MERGED / INSTALLED VERIFIED** olarak ayrı tut. Bunlar birbirinin yerine geçmez.
2. Her birleştirme öncesi exact PR head/base, değişen dosya sahibi, bağımlı child PR, workflow run/attempt ve mevcut main SHA'yı oku. **Yalnızca başarılı ve güncel hedef için merge.**
3. Bir PR kaynakta birleştiğinde kabul edilmeyen fiziksel issue'yu kapatma; sadece source-integrated işaretle. Aynı WAL veya PID düzeltmesini yeniden yazma.
4. Başka PR'lara base olan 281 stacked zincir, yeni AI çalışma dalları ve son 48 saatte dokunulan dallar otomatik kapatılmaz veya silinmez.
5. Silme için: main commit-ancestor veya eksiksiz patch eşdeğeri + açık PR head/base bağı yok + aktif CI yok + son HEAD SHA sabit + koruma süresi. Açık PR'nin kodu eşdeğer görünse bile kaynak sahibi/child zinciri ayrıca kontrol edilmeli.
6. Bağımsız CORE-dışı düşük riskli değişiklikleri önce küçük bir doğrulanmış entegrasyon PR'sinde topla; 27 Windows RED ve CORE NO-GO sınırları **asla** gevşetilmez.
7. Bu sayfadaki checkbox [x] sadece yazılı kapsamın başarıyla tamamlandığını gösterir. **Source merged ≠ signed release ≠ installed Windows PASS ≠ production CORE GO.**

## 6. Kanıt, rapor ve güncelleme

- Main snapshot: [4d699b8](https://github.com/Naveax/Nexowire/commit/4d699b8bbd8cb908c782a3776a34301c4a4c74b5).
- Fiziksel Naveax QA raporu: %LOCALAPPDATA%/Nexowire-QA/NEXOWIRE_WINDOWS_QA_20261101.md; yerel test logları aynı dizinde.
- Kritik açık sorunlar: [#974](https://github.com/Naveax/Nexowire/issues/974), [#1001](https://github.com/Naveax/Nexowire/issues/1001), [#540](https://github.com/Naveax/Nexowire/issues/540), [#1006](https://github.com/Naveax/Nexowire/issues/1006).
- İşlemden sonra bu panoyu, CSV envanterlerini, ilişkilendirilen issue/PR yorumlarını güncelle. Dünkü sayıların bugünkü gerçek durum gibi kullanılmasını önle.

**Durum kararı (2026-11-01):** kaynak WAL/Agent yerel açılışında ilerleme var; Windows suite **RED**, signed installed release **bekliyor**, CORE **NO-GO**, uzak Hub end-to-end **doğrulanmadı**.
