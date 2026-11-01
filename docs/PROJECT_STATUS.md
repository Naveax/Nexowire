# Nexowire | Tek Durum ve Entegrasyon Panosu

> **Güncel envanter: 1 Kasım 2026.** Kaynak: canlı GitHub API + tam Git geçmişi. Main snapshot: **4d699b8bbd8cb908c782a3776a34301c4a4c74b5**. Bu bir iş ve kanıt günlüğüdür; tek başına release, CORE veya fiziksel cihaz GO belgesi değildir.

**Başlangıç noktası burası.** [ROADMAP](../ROADMAP.md), [30 Ekim entegrasyon günlüğü](BRANCH_INTEGRATION_BATCH_20261030.md) ve [eski branch kataloğu](BRANCH_CATALOG.md) tarihsel kayıt olarak kalır. Bu sayfada yeni durum ayrımı kullanılır.

## 1. Canlı envanter

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
| **P0-D: Windows Job helper build** | scripts/build-windows-job-owner.ps1 MSVC Community tırnaklama hatası; ayrı /W4 /WX derleme PASS | Resmi builder ile aynı kaynak/helper derlemesi, temiz makinede tekrarlanabilir exit 0, negatif testler korunur |
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
