# Windows için kolay kurulum dosyası

**[Nexowire-Setup.cmd indir](Nexowire-Setup.cmd?raw=true)** ve normal çift tıkla.
GitHub dosya içeriğini gösterirse sağ üstteki **Download raw** düğmesini kullan.
Önceden Node, npm veya Git kurulması gerekmez.

[Bilgisayarı ve ChatGPT’yi adım adım bağlama](../docs/INSTALL_WINDOWS.md).

Bu dosya, depo kaynağından üretilen düzeltilmiş bir **bootstrap** kurucudur.
Yayımlanmış v1.0.7 uygulama ZIP’ini değiştirmeden kullanır. Windows kısayolunu
Türkçe karakterli kullanıcı yollarında açıkça Unicode Shell Link API’siyle
yazar ve kaydedilen yol/argümanları geri okur. Yönetici yükseltmesi veya ayrı
Broker kurulumu yapmaz.

Bu bir yeni uygulama yayını veya doğrulanmış Nexowire yayıncı imzası değildir.
Önceki resmî `Nexowire-Setup.cmd` yayın dosyası yerinde durur. Dosya hash’i
bayt bütünlüğünü kontrol eder; bağımsız yayıncı imzasının yerine geçmez.

## Kaynak ve doğrulama

| Kayıt | Sabitlenen değer |
| --- | --- |
| Uygulama yayını | [v1.0.7](https://github.com/Naveax/Nexowire/releases/tag/v1.0.7) |
| Yayının kaynak commit’i | `e9489175cf599c47f331a22c463421048d1ba407` |
| Değişmeyen ZIP SHA-256 | `1d463f408d9f18840748c2e83080adfa3f642afadefd000f8c43cadae5e20896` |
| Bu kurucunun hash’i | [SHA256SUMS-Windows](SHA256SUMS-Windows) |
| Kurucu kaynağı | [build-windows-user-bundle.ts](../scripts/build-windows-user-bundle.ts), [Unicode kısayol API’si](../scripts/windows-shortcut-interop.ts) |
| Tekrarlanabilir üretim | `node --import tsx scripts/generate-windows-stable-setup.ts` — geliştirici içindir |

Kurucu içinde Base64 olarak taşınan C# metni, aynı depodaki Unicode kısayol
kaynağıdır; cmd.exe tırnak sınırlarını bozmadan Windows’un yerleşik .NET/COM
API’sine aktarılır. Ayrı bir sunucudan yardımcı binary indirilmez.

İzole Windows CI; aday paketi Türkçe karakterli boş profilde, önceki yayımlanmış
kurucuyu ASCII boş profilde ve bu kurucuyu **aynı yayımlanmış ZIP ile** Türkçe
karakterli boş profilde ayrı sınar. PATH üzerinde Node/npm/Git/PowerShell 7 yoktur.
Görev kaydı ve tarayıcı/hesap girişi simüle edilir. Gizli başlatıcı ayrıca geçici
bir test CLI’siyle sınanır. Bunlar gerçek kullanıcı girişi, cihaz eşleme veya
ChatGPT OAuth başarısı olarak sayılmaz; kesin sonuç PR’ın exact-SHA CI kaydındadır.
