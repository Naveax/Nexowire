# Nexowire AI Screen | Default masaüstündeki sanal imleç katmanını engelleme

Eski `windows.virtual_pointer.start` Windows fare koordinatlarını fiziksel olarak değiştirmese bile **kullanıcının WinSta0\\Default masaüstü üzerinde WPF overlay penceresi** açar. Bu nedenle kullanıcı AI otomasyonu özel masaüstünde çalışırken de uygulamalarının üzerinde renkli bir imleç penceresi görebilirdi. Bu, AI Screen'in görünürlük izolasyonu gereksinimine aykırıdır.

Bu kaynak değişikliği, `NEXOWIRE_AI_UI_TARGET_DEFAULT=private_desktop` veya katı politika nedeniyle `resolveAiWorkspaceTarget` sonucu özel masaüstü olan Windows oturumlarında:

- `windows.virtual_pointer.start`, `move`, `style` ve `visibility` komutlarını `AI_VISIBLE_OVERLAY_NOT_ISOLATED` ile **herhangi bir WPF overlay başlatmadan** reddeder.
- `windows.virtual_pointer.status` ve `stop` komutlarını açık tutar; daha önce açılmış overlay'in görülmesi veya kapatılması engellenmez.
- `NEXOWIRE_AI_UI_TARGET_DEFAULT` kapalıyken önceki sanal imleç uyumluluğunu değiştirmez.
- Özel GUI üzerinde `windows.private_pointer.move/click` kullanılabilir, fiziksel fare hareket ettirilmez.

Windows DEV'de özel mod ve katı modu birlikte etkinleştirip, sanal imleç başlatma/hareket/stil/görünürlük eylemlerinin hiç WPF işlemi veya dosyası üretmeden reddedildiği; durum ve durdurmanın hâlâ çalıştığı doğrulandı. Odaklı testler **7/7 PASS**, TypeScript/build/diff PASS.

Bu, bütün Explorer/COM/WSLg/ShellExecute GUI yollarının izole edildiğini iddia etmez. #402 kullanıcı ekranı stres kabulü ve üretimde güvenli dağıtım işleri ayrı kalır. #271 üzerinde hiçbir işlem yapılmadı.
