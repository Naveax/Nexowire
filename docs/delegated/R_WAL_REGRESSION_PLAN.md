> Yardımcı 4 / 31 Ekim 2026 / belge ve sentetik test kapsamı.
> Kaynak tabanı: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main).
> Dal: `docs/delegated-r-rel-20261031`. AGENTS.md bulunmadı.
> Kaynak bağlantıları aşağıdaki göreli yollar için bu exact SHA üzerinden okunmalıdır:
> https://github.com/Naveax/Nexowire/tree/a19a228dc6f19fd484cf935e941a00ea625233f8
> Bu çalışma cihaz kabulü, güvenlik onayı veya üretim PASS değildir.

# R-01 — WAL tekrar testi planı

## Güncel durum ve kaynak

[#974](https://github.com/Naveax/Nexowire/issues/974) AÇIK. Eski 1.0.7 arızası: geçerli yeni nesil committed prefix arkasında fiziksel olarak ayrılmış eski nesil WAL suffix'i bulununca katı validator başlangıcı reddediyordu. Salt mismatch tek başına corruption kanıtı değildir. Son issue kaydı 1.0.8 canary, iki Agent restart ve iki Windows reboot kabulünü bildiriyor; bu rapor bunları yeniden çalıştırmadı. İki cihaz/24 saat/uyku-kesinti ve CORE kabulü henüz genellenemez.

- [#954](https://github.com/Naveax/Nexowire/pull/954): closed, merged; head `77781e4eee89e343bd7d988b35a720f6e20a4439`. Tarihsel RED run 40774871426, yeni kaynak başarısı ile yeniden etiketlenmez.
- [#957](https://github.com/Naveax/Nexowire/pull/957): closed, **merged=false**; head `88fa241df3c0c1721638bb2420918ae9fc3866bf`. Fix entegrasyonu [#978](https://github.com/Naveax/Nexowire/pull/978) üzerinden main'e ulaştı; #957 doğrudan merged denmez.
- #978 merged commit `62c1edff0d80590433872ded6ee2b6f791688573`.
- `src/agent/operation-journal-wal.ts`: mevcut nesli, committed sınırı, iki WAL-index header kopyasını, salt/checksum ve dosya stabilitesini doğrulayan kaynak. SHM uçucudur, anti-rollback otoritesi değildir.

## Senaryo matrisi — çalıştırma değil plan

Tüm fixture'lar ayrı temp içinde üretilmeli; hiçbir gerçek DB/WAL/SHM kullanılmamalı. Aşağıdaki sonuçlar BEKLENEN, bu oturumda ölçülen sonuç değildir.

| ID | Senaryo / kaynak test | Beklenen güvenli sonuç | Kanıt / sınır |
|---|---|---|---|
| W01 | Normal hot WAL / `agent-operation-wal-integrity.test.ts` | Geçerli frame kabul; dispatched kayıt unknown | Fixture çocuk süreç oluşturur; gerçek cihaz değil |
| W02 | RESTART ve reuse / `qa-journal-wal-recycle-p11.test.ts` | Current committed prefix + eski suffix kabul | SQLite üretimi, byte karşılaştırması değişmez |
| W03 | Tek başına salt mismatch | Suffix yalnız corroborated eski nesil ise kabul | Rastgele salt atlama yasak |
| W04 | Committed prefix ve WAL-only UNKNOWN | UNKNOWN ve tüm rowset korunur | Base-only DB UNKNOWN içermez; WAL gereklidir |
| W05 | Crash ve art arda journal restart / `agent-journal-restart-regression.test.ts` | 1307 sentetik kayıt/digest, 1 unknown, 1307 replay reddi korunur | 709 current + 295 retained, 8 journal süreci |
| W06 | Gerçek Agent CLI restart alt vakası / aynı dosya | Ayrı test Hub'a bağlantı, aynı kimlik ve journal | Yerel port/Agent başlatır: BU GÖREVDE ÇALIŞTIRILMADI |
| W07 | Orphan/stale SHM; matching WAL yok | Başarı varsayma; eşlenmiş bağımsız kanıt ve fail-closed sınıflama | Orphan SHM özel test kapsamı DOĞRULANMADI; ana ekip negatif eklesin |
| W08 | Reused WAL için SHM eksik / recycle testi | `AGENT_JOURNAL_WAL_CORRUPT`, WAL değişmez | SHM yeniden üretip kabul ettirme yok |
| W09 | SHM iki header kopyası farklı | Red, bytes değişmez | recycle testi |
| W10 | Checksum doğru ama committed frame sayısı yanlış | Red; WAL-only UNKNOWN atılmaz | recycle testi |
| W11 | Frame data/header checksum corruption / integrity testi | SQLite recovery öncesi red, bytes korunur | Veri byte, frame checksum, header checksum |
| W12 | Torn son frame / integrity testi | Red; truncate/onarım yok | WAL değişmez |
| W13 | Geçerli magic, geçersiz page size | Red | integrity testi |
| W14 | Birden çok eski nesil recycle | Geçerli sıralama kabul, tüm işlemler korunur | recycle testi |
| W15 | Eski sınırdan sonra gizlenmiş current frame | Red | recycle testi |
| W16 | Current commit'in old diye etiketlenmesi | Red; UNKNOWN korunur | recycle testi |
| W17 | Eski nesillerde yanlış salt sırası / ikinci salt değişimi | Red | recycle testi |
| W18 | False-positive tekrar kontrolü | Aynı fixture ve aynı SHA tekrarında aynı sınıflama, girdi hashleri değişmez | Windows/Linux sonuçları ayrı kaydedilir |

## Güvenli inceleme ve kabul

Bu görevde yalnız test kodu okundu. WAL testleri çalıştırılmadı: bir kısmı recovery/checkpoint fixture'ı veya Agent/Hub süreci içerir. Kullanıcının yasakladığı recovery işlemi için komut verilmez. Ana ekip ayrı yetkili lab'da mevcut testleri inceleyip seçmelidir; bütün restart dosyasını körlemesine çalıştırmamalıdır.

Her çalışmada ID, issue, branch, exact SHA, komut, OS/Node, zaman, beklenen/gözlenen, exit code, sentetik/cihaz ayrımı, CI ID ve engel tutulmalı. Kabul: pozitif geçerli recycle + negatif corruption birlikte; sırf pozitif geçsin diye assertion gevşetilmez. UNKNOWN mutation tekrar yürütülmez. Gerçek journal silme/rename/swap, checkpoint, truncate, VACUUM, stale restore ve recovery bu görev kapsamı dışıdır. Kalıcı validator düzeltmesi ana ekibe aittir.
