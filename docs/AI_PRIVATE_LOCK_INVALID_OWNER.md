# NexowirePrivate | Kilit sahibi bilinmiyorsa fail-closed

## İncelenen yarış durumu

Çoklu Agent PID'leri için eklenen çapraz-süreç kilidinde
(`#412`) mevcut uygulama, `owner.json` dosyasını
okuyamadığında veya JSON biçimi geçersiz olduğunda
kilit sahibini `null` kabul edebiliyordu. Kilit
dizini 30 saniyeden eskiyse bu, **sahibi halen
çalışıyor olabilecek** bir kilidin kaldırılması
ve aynı özel masaüstüne ikinci Agent'ın eşzamanlı
girmesi riskine yol açıyordu.

## Düzeltme

- `owner.json` eksikse sahibin ölü olduğu
  **varsayılmaz**. Kilit korunur; bekleme süresi
  sonunda `PRIVATE_DESKTOP_LIFECYCLE_LOCK_BUSY`
  ile güvenli şekilde reddedilir.
- Geçersiz JSON, hatalı PID/nonce/zaman alanı veya
  okunamayan metadata artık
  `PRIVATE_DESKTOP_LOCK_OWNER_INVALID`
  veya ilgili okuma hatasıyla kapanır.
  Hiçbir zaman `null` sahibe çevrilip
  otomatik silme nedeni yapılamaz.
- Otomatik kurtarma yalnızca
  **geçerli PID/nonce bilgisi olan, gerçekten
  yaşamayan süreç** için ve en az 30 saniyelik
  gecikmeyle yapılır. Kurtarma dizini
  atomik oluşturulur.
- Kilit alınamadığında özel masaüstünün
  çalışması ve kullanıcı `Default` masaüstü
  kontrolü etkilenmez; görünür GUI'ye
  sessiz geri dönüş yapılmaz.

## DEV kabul

Windows DEV'de yanlış/eksik sahibi olan eski
kilitlerin korunması, canlı PID'nin hiç
silinmemesi, ölmüş PID'nin kurtarılması,
iki ayrı Node PID'si arasında kilit
ve mevcut Win32 ayrı ekran/sanal input
testleri **8/8 başarılı** çalıştırıldı.
TypeScript ve derleme kontrolleri başarılı.

## Bilinen sınır

Sahibi bilinmeyen ve program çökmesiyle
kalıcı olmuş kilit artık otomatik silinmez.
Böyle bir durumda sahibin ölümü ve
doğru runtime kökü bağımsız şekilde
doğrulanmadan zorla silinmemelidir.
Bu kaynak düzeltmesidir; üretimde P0 #271
ve tam AI ekran kabulü #402 açık kalır.
