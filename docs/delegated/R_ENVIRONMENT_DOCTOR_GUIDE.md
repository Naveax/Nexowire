> Yardımcı 4 / 31 Ekim 2026 / belge ve sentetik test kapsamı.
> Kaynak tabanı: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main).
> Dal: `docs/delegated-r-rel-20261031`. AGENTS.md bulunmadı.
> Kaynak bağlantıları aşağıdaki göreli yollar için bu exact SHA üzerinden okunmalıdır:
> https://github.com/Naveax/Nexowire/tree/a19a228dc6f19fd484cf935e941a00ea625233f8
> Bu çalışma cihaz kabulü, güvenlik onayı veya üretim PASS değildir.

# R-03 — Environment Doctor raporu okuma

Kaynaklar: `scripts/run-environment-doctor.ts`, `docs/environment-doctor.md`, `src/diagnostics/environment-doctor.ts`, `test/environment-doctor.test.ts`. Mevcut aracı yeniden yazmaz. Burada host probe çalıştırılmadı.

## Önce provenance

`origin=synthetic_fixture` simülasyondur; `ready=true` olsa bile cihaz kabulü değildir. Injected runner yalnız synthetic olabilir. `live_readonly` yalnız iç runner, gerçek platform/mimari/saat ile üretilebilir. `readonly=true`, `permissionsChanged=false`, safety alanlarını kontrol et. `physicalAcceptance` USB/gamepad/phone/virtual_machine için her durumda `not_tested` kalır.

Her check: name, required, status, code, probeIds, bounded observed ve varsa `fix` içerir. `fix.approvalRequired=true`, `execution=manual_only` metin planıdır; otomatik onarım değildir. Zorunlu check'lerin hepsi pass değilse ready false. CLI stdout JSON; exit 0 ready, exit 2 zorunlu gereksinimler kesin karşılanmadı, exit 3 argüman/üst düzey hata. Probe stderr rapora ham olarak eklenmez.

| Alan | Gerçek kapsam | Çıkarılamayacak sonuç |
|---|---|---|
| Node/Python/Rust/Git/Ollama | Version minimum kontrolü | Uygulama veya modelin çalıştığı |
| Python paketleri | importlib.metadata sürümü; proje modülü import edilmez | Torch import/ABI veya CUDA çalışma kabulü |
| Docker | CLI ve daemon ayrı | CLI var diye daemon hazır değildir |
| NVIDIA/VRAM | nvidia-smi; Windows GPU fallback | Stres/kernel veya generic AMD VRAM kabulü |
| CUDA | nvcc toolkit / driver advertised maximum | CUDA runtime veya framework uyumu; nvcc eksikliği runtime yok demek değildir |
| WSL | Windows `wsl --list --verbose`, beklenen distro adı | Distro boot olduğu |
| Hyper-V | Firmware/SLAT/hypervisor metadata | Gerçek VM açıldığı |
| USB | VID/PID ve PnP status | Telefon/gamepad/kablo fonksiyonel kabulü |
| Volumes | GUID/drive metadata veya lsblk inventory | Boş disk alanı eşiği: mevcut Doctor bunu ölçmüyor |
| Network | Adapter link ve DNS config varlığı | DNS çözümleme/TCP/internet erişimi; IP/MAC/ham DNS adresi yayımlanmaz |
| Agent offline | Bu CLI Agent'a bağlanmaz | Hub/Agent/Broker online kararı desteklenmiyor |

## Kodları yorumlama

| Kod | Yorum |
|---|---|
| OK | Yalnız o check'in kanıtı yeterli |
| MISSING_DEPENDENCY / VERSION_MISMATCH | Gereken araç/paket/distro yok veya minimum karşılanmıyor |
| DRIVER_NOT_STARTED / DEVICE_NOT_PRESENT | PnP/driver veya beklenen VID/PID; fiziksel test değildir |
| PERMISSION_REQUIRED | Sorgu izni yetersiz; otomatik yükseltme yapma |
| UNSUPPORTED_HARDWARE / VIRTUALIZATION_DISABLED | Kaynakta bildirilen metadata gereksinimi karşılamıyor |
| SERVICE_NOT_RUNNING | Örn. Docker daemon doğrulanmadı; Agent servisi genellemesi değil |
| PROBE_FAILED / PROBE_TIMED_OUT | Sorgu sonucu alınamadı; bağımlılık kesin yok demek değildir |
| INSUFFICIENT_EVIDENCE | Unknown bırak; boş/malformed çıktıyı pass sayma |
| PHYSICAL_TEST_REQUIRED | Ayrı gerçek cihaz prosedürü gerekli |

Kaynakta bulunan salt-okunur örnek komut (bu oturumda ÇALIŞTIRILMADI):

```powershell
node --import tsx scripts/run-environment-doctor.ts --tool=node:22 --tool=python:3.11 --python-package=torch:2.5 --require-nvidia --require-cuda --min-vram-mib=8192
```

İsteğe bağlı gerçek flag'ler: `--require-wsl`, `--wsl-distro=Ubuntu-22.04`, `--require-hyperv`, `--usb-vid-pid=1234:ABCD`. Gereksinimleri iş yüküne göre seç; eksik ölçümü onarım komutuna dönüştürme. Doctor network erişim testi yapmaz; burada da canlı diagnostic/probe yapılmadı. Fiziksel lab ve repair ayrı yetki ister.
