# Nexowire AI Screen | Katı özel masaüstü politikası

## Sorun

`NEXOWIRE_AI_UI_TARGET_DEFAULT=private_desktop` yalnızca **varsayılan tercih** idi. Bir görev, tarayıcı başlatma veya iç runbook açıkça `ui_target:headless` gönderdiğinde tercihi geçersiz kılabiliyordu. `headless`, kendi başına Windows'un `Default` masaüstüne GUI penceresi açılmayacağının garantisi değildir.

## Yeni, varsayılanı kapalı seçenek

Sahibi tarafından onaylanmış Windows **DEV** ortamında:

```powershell
$env:NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop'
$env:NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE='1'
```

Bu iki ayar Windows kullanıcı oturumunun Agent çalışma ortamında mevcutsa merkezi `resolveAiWorkspaceTarget` politikası, açık bir `ui_target:headless` talebini bile `AI_PRIVATE_DESKTOP_POLICY_REQUIRED` koduyla reddeder. Alt görevlerin politika sınırını sessiz düşürmesine izin vermez.

- `ENFORCE_PRIVATE=1` ve varsayılan hedef belirtilmemişse, hedef doğrudan `private_desktop` olarak seçilir.
- `ENFORCE_PRIVATE=0` ya da değişken bulunmadığında önceki davranış korunur: varsayılan `headless`, açık `ui_target` tercihi geçerlidir.
- Başka bir değer (ör. `true`, `yes`, boş dizge) `AI_WORKSPACE_ENFORCEMENT_POLICY_INVALID` hatasıdır; sessizce devre dışı bırakılmaz.
- Windows dışı sistemlerde katı özel masaüstü seçimi reddedilir.
- WSLg/Explorer ile Windows `Default` masaüstüne geçebilecek süreçler özel alana bağlanamadığından `wsl.exec` katı modda çalışmaz. Açık `headless` bile katı politikayı aşamaz.
- Özel Win32 masaüstü başlatılamıyorsa görünür `Default` masaüstüne alternatif başlatma yapılmaz.

Bu, `FULL`/`CORE`/`ROOT` yükseltmesi veya fiziksel konsol izni **değildir**. Fiziksel odak, fare/klavye ve masaüstü değişimi için ayrı yerel onay kapısı korunur. Kullanıcı tarafından **doğrudan** fiziksel konsola açıkça onay verilmiş komutlar başka politika ile değerlendirilir.

## DEV testleri

Merkezi politikanın katı/yumuşak modu, eski geriye uyumluluğu, bilinmeyen konfigürasyonu reddi, WSLg ve Windows dışı reddi, gerçek Windows `shell.exec(ui_target=headless)` çağrısının bir alt süreç başlatmadan reddedilmesi test edilmiştir. Bu PR hiçbir makinede kalıcı sistem ortamı değiştirmez veya üretimde katı modu açmaz.

## Açık kabul sınırları

- Katı politika, normal AI çalışma girdilerini denetler; keyfi kurulum/Explorer/COM aracılığıyla GUI oluşturan tüm Windows mekanizmalarına işletim sistemi çapında sandbox sağlamaz.
- Mevcut üretim Stack ACL riski #271 ve gerçek uzun süreli AI Screen UX kabulü #402 çözülmeden cihaz dağıtımı yapılmaz.
- Bu değişiklik bir **kaynak kodu politikasıdır**, kullanıcının fiziksel ekranını canlı gözetleme veya kontrol etme yetkisi sağlamaz.
