# AI-08 | STATUS

**Durum:** `IN_PROGRESS` kaynak QA; **CORE production: NO_GO**.  
**Branch:** `ai/08-independent-qa-20261031`  
**Draft PR:** [#989](https://github.com/Naveax/Nexowire/pull/989)  
**Base branch:** `local/persistent-enrollment-v2-20261031`  
**Base SHA:** `9d0f35607d4cde87bd031e2da77855cfaf570c31` (#984; stack #983/#982/#981/#980/main).  
**Önceki ölçülmüş kod HEAD:** `44f18a925974c9eb9743d366ded1d81ca851b95a`; CI `41194807179`.  
**Son kaynak commit:** `913230d378d9331eab01d7bb36094123d4fbe107` (D1 claim-ready testleri eklenmiş; exact yeni CI `41195396312` pending gözlendi).  
**Bu dokümantasyon commit'inin nihai SHA'sı:** commit yaratılmadan öngörülemez; PR HEAD/CI üzerinden ayrıca doğrulanacak.

## Kapsam
Yeni `test/ai08-*.test.ts` dosyaları:
- `ai08-enrollment-sandbox` (kalıcı owner, revoke, SID/machine/epoch, fake sandbox)
- `ai08-broker-receipt` (signed bytes, ABA, capability/scope, ACK loss)
- `ai08-wal-recycle` (disposable SQLite WAL eski allocation vs güncel tam frame)
- `ai08-cas-scope` (deep nested scope, signed owner substitution, Broker readback race)
- `ai08-mtls-pin` (localhost TLS SPKI pin ve sabit origin)
- `ai08-console-claim` (D1 claim beklerken offline/privilege/platform/CORE readiness değişimi)
Ayrı 5 teslim dokümanı yalnız `docs/ai-handoff/AI-08/**` içinde.

## Ölçülen eski QA HEAD
Node 22 ve Node 24 `41194807179`: **17/17 AI-08 test PASS**; her biri toplam 2787 test, 2431 PASS, 0 FAIL, 354 SKIP, 2 TODO. Typecheck/build SUCCESS. Bu başarı **eklenen son D1 test dosyası için kanıt değildir**; o, yeni HEAD CI'da ölçülmelidir. Söz konusu run'ın tüm OS işlerinin nihai durumu ayrıca izlenir.

## Sonraki kapı
PR #989 nihai HEAD için `npm run typecheck`, `npm test`, `npm run build`, Windows/OS workflow job sonuçları ve gerçek exit-code koşullarını kontrol et; aynı exact SHA için duplicate CI tetikleme. Source PASS olsa bile fiziksel 2-PC CORE ve native sandbox kabulü BLOCKED/NO_GO'dur.
