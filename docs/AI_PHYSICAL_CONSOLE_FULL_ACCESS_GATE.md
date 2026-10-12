# Nexowire | Fiziksel ekran erişimi FULL modda da ayrı onay gerektirir

## Neden

Önceki mantıkta FULL Access sahibin kontrol panelindeki
yetkilendirmesini fiziksel Windows masaüstüne doğrudan
erişim için yeterli sayıyordu. Dolayısıyla
`windows.private_desktop.show`, pencere odağı, fiziksel
fare/klavye ve diğer fiziksel giriş eylemleri FULL
modda kısa süreli yerel onay olmadan yürütülebiliyordu.
Bu durum arka planda çalışan AI'nın sahibinin
bilgisayarını kullanırken odağını değiştirmesine
sebep olabiliyordu.

## Yeni kapı

`needsPhysicalConsoleApproval` artık SAFE ve FULL
için aynı şekilde `requiresPhysicalConsoleGrant`
listesini uygular. FULL uzaktan API izni, fiziksel
ekranın otomatik kontrol izni değildir. Korunan
pencere/clipboard/fare/klavye/odak/özel masaüstü
gösterme eylemleri **yerel Windows onayına**
bağlıdır. FULL çağrısıyla gelen
`windows.console_control.request` artık
`owner-full-access` otomatik onayı üretmez;
yerel kullanıcıdan azami 60 dakikalık onay ister.
Onay yoksa işlem `PHYSICAL_CONSOLE_GRANT_REQUIRED`
ile fail-closed reddedilir.

Bu, `NexowirePrivate` içindeki sanal fare/
klavye ve görüntüleme yeteneklerini etkilemez.
Özel alanda çalışma fiziksel fare hareketi,
pencere odağı veya masaüstü değiştirme için
yerel onay gerektirmez. Konsol izni sahibi
`windows.console_control.revoke` ile iptal
edebilir; izin kendiliğinden sona erer.

## DEV kabul

Gerçek Windows DEV ortamında SAFE ve FULL
yetkilerinin fiziksel erişimi varsayılan
olarak reddettiği, ayrı özel masaüstünde
sanal input'un çalışabildiği ve süreli
onayın doğal sona erdiği odaklı testlerle
doğrulandı. Canlı üretim görevleri,
ACL, Broker, Hub, Worker veya Agent
çalışma ayarları değiştirilmedi.

Kontrol istenen yerel Windows onay penceresinin
kendisi sahibin dikkatini çekebilir; sadece
kullanıcı onay talebini bilinçli seçerse
başlatılmalıdır. Sessiz arka plan AI görevi
otomatik onay istememelidir. Tam #402 UX kabulü
ve P0 #271 güvenlik geçişi devam eder.
