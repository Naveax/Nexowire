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
