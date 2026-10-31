# REL-01 — 1.0.8 taslak sürüm notları

31 Ekim 2026, yardımcı 4. Bu sürüm ilanı değildir. Görev dosyasının gelecekteki 1.0.8 varsayımı güncel kayıtlarla aşağıda ayrıştırılmıştır.

## Kanıt katmanları

| Katman | Güncel doğrulama | Sınır |
|---|---|---|
| 1.0.8 için planlanan | WAL restart güvenilirliği, kurulum ve update startup tanısı | Plan tek başına kabul değil |
| Kaynak kodunda görülen | main `a19a228dc6f19fd484cf935e941a00ea625233f8`, package.json 1.0.8, WAL validator/testleri, startup/update/launcher testleri; #978 merged `62c1edff0d80590433872ded6ee2b6f791688573` | Kendi PR'ımız bu kodları değiştirmez |
| CI doğrulandı | Aynı main SHA [41078541065](https://github.com/Naveax/Nexowire/actions/runs/41078541065) completed/success; tag Readiness [41082039175](https://github.com/Naveax/Nexowire/actions/runs/41082039175) completed/success | API yeniden okundu; yeni HEAD veya kullanıcı cihazı için sonuç aktarılamaz |
| Release yayımlandı | [v1.0.8](https://github.com/Naveax/Nexowire/releases/tag/v1.0.8), API draft=false, prerelease=false, published_at=2026-10-30T15:55:53Z | Asset byte/signature/hashleri bu oturumda indirilip doğrulanmadı. GitHub publication, tek başına Authenticode installer kanıtı değildir |
| Cihazda yüklendi | [#974 son kabul kaydı](https://github.com/Naveax/Nexowire/issues/974): owner-authorized canary Agent/Broker 1.0.8, iki Agent restart ve iki Windows reboot, 1703 orijinal row korunmuş | Ana ekibin kayıtlı kanıtı; bizim canlı yeniden doğrulamamız değil. İkinci cihaz/24h/uyku-kesinti/clean Win10-11 ve fiziksel CORE kabulü yok |

## İlgili güncel PR'lar

| PR | Durum | exact head | Base | Aynı head CI |
|---|---|---|---|---|
| [#954](https://github.com/Naveax/Nexowire/pull/954) | closed; merged=true; draft=true | `77781e4eee89e343bd7d988b35a720f6e20a4439` | `main` | Tarihsel PR açıklaması; bu tabloda yeniden CI doğrulanmadı |
| [#957](https://github.com/Naveax/Nexowire/pull/957) | closed; merged=false; draft=true | `88fa241df3c0c1721638bb2420918ae9fc3866bf` | `qa/11-journal-wal-recycle-20261029` | Tarihsel PR açıklaması; bu tabloda yeniden CI doğrulanmadı |
| [#978](https://github.com/Naveax/Nexowire/pull/978) | closed; merged=true; draft=false | `de5813ab0c6eeebd081a4db1a2df42ee796f5186` | `main` | Tarihsel PR açıklaması; bu tabloda yeniden CI doğrulanmadı |
| [#980](https://github.com/Naveax/Nexowire/pull/980) | open; merged=false; draft=true | `7e4093c30c1ead3cd22888184450c34aef4737da` | `main` | [41113730994](https://github.com/Naveax/Nexowire/actions/runs/41113730994) completed/success; [41113730982](https://github.com/Naveax/Nexowire/actions/runs/41113730982) completed/success |
| [#981](https://github.com/Naveax/Nexowire/pull/981) | open; merged=false; draft=true | `b4d6e57053cce6738087e8cecf932fab3492f3c3` | `integration/core-after-v108-20261030` | [41120875406](https://github.com/Naveax/Nexowire/actions/runs/41120875406) completed/success |
| [#982](https://github.com/Naveax/Nexowire/pull/982) | open; merged=false; draft=true | `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39` | `core/bounded-native-verifier-host-20261030` | [41139860087](https://github.com/Naveax/Nexowire/actions/runs/41139860087) completed/success |
| [#983](https://github.com/Naveax/Nexowire/pull/983) | open; merged=false; draft=true | `21ae78aabf074db67c7bf46d20911a9d09f5b891` | `core/native-verifier-mtls-client-20261031` | [41142754565](https://github.com/Naveax/Nexowire/actions/runs/41142754565) completed/success |
| [#984](https://github.com/Naveax/Nexowire/pull/984) | open; merged=false; draft=true | `9d0f35607d4cde87bd031e2da77855cfaf570c31` | `local/persistent-enrollment-design-20261031` | [41145160595](https://github.com/Naveax/Nexowire/actions/runs/41145160595) completed/success |

#980–#984 hâlâ Draft/unmerged. #981–#984 base'leri birbirine bağlı feature branch'lerdir; main'e girmiş veya 1.0.8 release'inde var sayılmaz. #983 mimari tasarım; #984 opt-in service kaynak adayıdır. mTLS/test başarısı gerçek enrollment, SCM/TPM rollout veya CORE production kabulü değildir. Bu destek PR'ının base'i yalnız main olacaktır.

## Bilinen açıklar ve release dışı işler

- [#974](https://github.com/Naveax/Nexowire/issues/974) ve [#539](https://github.com/Naveax/Nexowire/issues/539) açık. Historical issue üst metni ile son kabul güncellemesini karıştırma; 1.0.7 recovered kaydını güncel kurulu durum diye kopyalama.
- WAL: geçerli retained suffix kabul edilirken bozuk current frame/SHM/torn write/replay reddi korunmalı. Recovery veya journal reset dağıtım yolu değildir.
- Kurulum/update: #978 BOM/Unicode launcher, nonce/PID/version doğrulanmış cutover ve data-preserving rollback kaynağını içerir. Clean Windows ve her cihazın güncel kurulumu UNKNOWN; kaynak testinden signed installer kabulü çıkmaz.
- CORE disabled / production NO-GO sınırı sürer. Bağımsız yetki/current revoke/restore custody, service/provider composition ve gerçek cihaz rollout'u ana ekip sorumluluğudur.
- Billing kapalı, mevcut aylık Free-only politika değişmedi; Scale planları rollout kanıtı değildir.

## İnceleme kaydı

Tarih/saat: bu dosyanın git commit zamanı (Europe/Istanbul gösterimiyle raporlanır). OS Linux, Node v24.22.1. Kanıt: repository source + GitHub API read-only + yalnız sentetik yeni test. Açık PR listesi ve güncel CI okundu; bu dosyalarda çakışma olan PR görülürse koordinatör incelemeyi durdurmalı. Gerçek log, cihaz, CORE/Broker/auth/üretim müdahalesi YOK. Yerel test ve exact teslim SHA'sı FINAL_HANDOFF/PR açıklamasındadır.

