# Nexowire AI Screen | Bozuk özel masaüstü durumunda güvenli yeniden başlatma

## Sorun

`windows.private_desktop.start` önceki durumda
`state.json` dosyasını okuyamazsa veya şema/JSON
bozuksa bunu hiç kayıt yokmuş gibi yorumlayıp
durum dosyasını siliyor ve yeni Win32 masaüstü
host'u başlatabiliyordu. Mevcut host halen
çalışıyorsa bu, iki bağımsız host'un aynı
`NexowirePrivate` nesnesine bağlanmasına ve
mevcut GUI süreçlerinin kayıtlarının kaybına
sebep olabilirdi.

Geçerli bir dosyada bile host PID veya shell PID'den
yalnızca biri yaşıyorsa ya da önce açılan uygulama
PID'leri çalışmaya devam ediyorsa, yeniden başlatma
o PID'leri yok sayıp state'i yeniliyordu.

## Düzenleme

- `state.json` gerçekten **ENOENT** olduğunda
  kayıt yok kabul edilir. Bozuk JSON ve geçersiz
  şema `PRIVATE_DESKTOP_STATE_INVALID` ile
  fail-closed döner; dosya silinmez.
- Bilinmeyen dosya okuma erişim ve disk hataları
  da kayıtsız sistem olarak yorumlanmaz.
- Kayıt geçerliyse ama host, shell veya önceki
  uygulama PID'lerinden herhangi biri halen canlı
  görünüyorsa yeni host başlatılmaz.
  `PRIVATE_DESKTOP_PARTIAL_HOST` döner.
- Host ve shell zaten birlikte çalışıyorsa
  normal reuse yolu korunur. Kayıt mevcut ama
  host, shell ve tüm uygulamalar gerçekten
  durmuşsa eski durumu temizleyerek başlatma
  seçeneği korunur.

## DEV kabul

Salt ayrı kaynak çalışma ağacında, geçici
runtime kökleriyle Windows DEV kabulü
gerçekleştirildi. Bozuk JSON, geçersiz şema,
kısmi canlı host/shell, sadece çalışan
uygulama PID'si ve mevcut gerçek özel GUI/
sanal fare/klavye doğrulamaları **6/6 PASS**.
Tip denetimi ve derleme PASS.

Kilit PID kimliği güvenli silinebilir biçimde
kesin olarak doğrulanamıyorsa otomatik düzeltme
yapılmaması bilinçlidir. Üretim P0 #271 ve
tam UI #402 değerlendirmeleri devam ediyor.
