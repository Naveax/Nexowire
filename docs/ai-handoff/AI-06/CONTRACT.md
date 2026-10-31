# AI-06 | CORE console claim ve native session sözleşmesi

**Kapsam:** D1 reserve/claim, Agent/provider'ın claim sonrası son kontrolü, native effect sınırına devredilen zorunlu güvenlik koşulları. Bu belge kendi başına yetki vermez.

## Kaynakta mevcut sözleşme

1. `reserve` yalnız güncel `READY` satırı için benzersiz `(requestId, fingerprint, device, installation, enrollment, ownerEpoch, grantGeneration, revokeEpoch)` ile yapılır.
2. `claim` bir defalık `reserved -> dispatched` değişikliğinden **sonra** asenkron bağımsız native oturum readback'i bekler. Başarısız/UNKNOWN/readback kaybı **terminal** `unknown` tombstone bırakır. Aynı request ID tekrar kullanılamaz. Kaybeden paralel talep kazananın `dispatched` kaydını bozamaz.
3. Readback sonrasında D1 kaynak satırı yeniden okunur; `deviceReady=true`, `devicePlatform='win32'`, owner/device/install/enrollment, epoch'lar ve SID/session/LUID/session-epoch birebir aynı olmalıdır. `READY`: FULL, online, Windows, Broker privilege, admin bridge readiness, CORE preference ve bridge desired mode.
4. Agent'ın Windows provider'ı `claim` ACK sonrasında `inspect()` çalıştırır. Güncel D1, Broker probe, protected native receipt readback, owner/logon, desktop ve STOP/pending kayıtları yeniden doğrulanır. `devicePlatform` eksikse, `deviceReady` true değilse veya onay sağlayıcısı yoksa callback yoktur.
5. İstek kimliği, capability, input snapshot ve fingerprint eşleşmelidir. Belirsiz native sonuç `UNKNOWN` olarak kalır; yerel STOP ve harici revoke/drain süreci onu başarılı sayamaz.
6. `CoreNativeSessionObservation` yalnız `OS_OBSERVATION_ONLY` / untrusted readback verisidir. Win32 session görüntüsü ve imzalı/korumalı fiziksel kullanıcı onayı aynı şey değildir.

## Zorunlu dış bağımlılık

Gerçek native effect'in **tam öncesinde**, korunmuş Windows işletim sistemi sınırı aşağıdakileri bir bütün olarak kontrol etmelidir: doğru imzalı process image ve origin, doğru cihaz/owner SID, token AuthenticationId LUID, aktif konsol session ve epoch, interactive window station, default input desktop, handle/PID creation identity, yetkili hedef, native grant/CAS ve revoke/STOP nesli. Sonuç değişirse veya UNKNOWN ise **efekt çalışmamalı**.

**Önerilen arayüz (tasarım talebi, uygulanmış API değil):**

```ts
interface ProtectedFinalEffectCheck {
  verifyAndConsumeBeforeEffect(input: {
    requestId: string;
    fingerprint: string;
    capability: string;
    ownerAccountId: string;
    deviceId: string;
    installationId: string;
    enrollmentId: string;
    ownerEpoch: number;
    grantGeneration: number;
    revokeEpoch: number;
    windowsUserSid: string;
    windowsSessionId: number;
    windowsLogonLuid: string;
    windowsLogonSessionEpoch: string;
    targetCreationIdentity: string;
  }): Promise<'ALLOW_ONCE' | 'DENY' | 'UNKNOWN'>;
}
```

Bu çağrı JS önkontrolüne güvenemez; gerçek etkiyi üreten korumalı native sınırda atomik yapılmalıdır. `ALLOW_ONCE` kalıcı CORE açma veya fiziksel kanıt değildir.

## AI-06 kalite sınırı

`test/ai06-consent-claim-races.test.ts` D1'in asenkron race/tombstone davranışını **yalnız sentetik bellek içi SQL ve verifier** ile inceler. Windows/native consent, Windows enrollment, production D1, OS target readback ve fiziksel iki-PC kabulü bu testlerin kapsamı dışındadır. `CORE_EXECUTOR_DISPATCH_ENABLED=false`, Draft, production NO-GO korunur.

## Giriş nesnesi değişmezliği

`WindowsCoreConsoleProvider.execute()`, sıraya almadan önce bütün `CoreConsoleDispatch`
girdisini JSON ile bağımsız bir nesneye dönüştürür; hem hash karşılaştırması hem
son native effect **bu aynı snapshot** üzerinden çalışır. Deserialization
başarısızsa `CORE_DISPATCH_SNAPSHOT_INVALID` döner. Bu koruma JS süreç içi
mutation TOCTOU içindir; gerçek native etki öncesi bağımsız CAS/OS readback
gerekliliğini kaldırmaz.

## Geç iptal, STOP ve callback öncesi son kontrol

`WindowsCoreConsoleProvider.inspect()`, asenkron
`store.stopped()/store.blocked()` tamamlandıktan **sonra**
`closed/revoked/signal.aborted` değerlerini yeniden kontrol eder.
`execute()`, son readback ve native callback arasında `store.stopped()`
ile birlikte yeniden `closed/revoked/signal.aborted` kontrol eder.
Geç abort sonucu `unknown` + STOP; native effect callback çağrılmaz.
Bu JS sınırı gerçek OS effect ile atomik değildir: native protokolde
owner/session/revoke/CAS ve effect-boundary doğrulaması yine zorunludur.

## Completion ACK sırasında geç iptal

`execute()` native çağrının tamamlanmasından sonra `complete` isteği
gönderilmeden önce ve uzaktaki `complete` yanıtı geldikten sonra
`STOP`, `revoked`, `closed` ve `signal.aborted` durumlarını
yeniden kontrol eder. İptal eşzamanlı geldiyse kullanıcının karşısına
eski bir `succeeded` cevabı çıkarılmaz. Kalıcı yerel STOP,
`pendingDispatch` koruması ve revoke uygulanır. Fiziksel etki zaten
gerçekleşmiş olabilir; bu durum sahte `denied` olarak sunulmaz.
Uzak D1 tamamlanma ACK'sinin iptal ile yarışı protected effect-boundary
CAS/generation gereksinimini ortadan kaldırmaz.

## Enroll ACK ile iptal/revoke nesil kontrolü

`WindowsCoreConsoleProvider.enroll()`, kendi kontrollü pre-enrollment
`revoke()` çağrısından **sonra** monoton `stopSequence` değerini yakalar.
Bu esnada başka bir STOP, harici revoke, cancellation veya close oluşursa
onay uzaktan kaydedilmiş olsa bile `clearStop/clearBlock/startMonitor`
aşamaları sonrasında **aktivasyon verilmez**. Bu async aşamalar boyunca
`revoked` true tutulur; yalnız son nesil/iptal kontrolü geçtiğinde
false olur. Hata halinde kalıcı STOP ve remote revoke tekrar uygulanır.
Bu işlem korumalı native approval veya fiziksel console kabulünün yerine
geçmez.

## Native DENY sonrası eşzamanlı erken completion için terminal denetim

D1 `claim` kazananı, native `currentReadback()` sonucunda DENY/UNKNOWN
alırsa kendisinin `dispatched` kaydını `unknown` yapar. Bu arada başka
imzalı `complete` isteği `succeeded` veya `denied` yazmışsa, aynı
`requestId/fingerprint/device` için bu sonuç da **UNKNOWN** olur.
Duplicate kaybedeni kazananın kaydına dokunamaz.

**Bu yalnız audit/tombstone düzeltmesidir.** Mevcut operasyon şeması
`complete` isteğinin native readback tamamlanmadan kabul edilmesini
önleyemez. Protected/native-verified claim CAS işaretleyicisi ve gerçek
effect-boundary doğrulaması gelene kadar CORE production NO-GO.

## Üst seviye admission controller revoke sırası

`CoreConsoleAdmission.revoke()` ilk senkron satırda monoton
`revokeSequence` değerini artırır, STOP'u latch eder ve önceki admission
`AbortController`'ını iptal eder. `CoreConsoleAdmission.enroll()`,
`provider.enroll()` asenkron başlamadan önce nesli yakalar ve dönüşte
karşılaştırır. Araya revoke girdiyse yerel `stopped=false` yapılmaz,
`CORE_ENROLLMENT_REVOKED_DURING_APPROVAL` hatası üretilir.
Bir sonraki **yeni** yerel enrollment mevcut revoke neslini yakalayıp
proven/native approval olmadan yetki üretmeden yürüyebilir. Yalnız sentetik
mock testinden physical consent kabulü çıkmaz.
