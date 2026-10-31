# AI-08 | STATUS

**Durum:** IN_PROGRESS · independent QA branch only · CORE production **NO_GO**  
**Branch:** `ai/08-independent-qa-20261031`  
**Temel:** #984 `local/persistent-enrollment-v2-20261031`, exact SHA `9d0f35607d4cde87bd031e2da77855cfaf570c31`  
**Ana dal kontrolü:** `main` `a19a228dc6f19fd484cf935e941a00ea625233f8` (31 Ekim 2026)  
**Final HEAD/CI:** PR açıldıktan sonra GitHub'dan exact HEAD ve workflow run ID ile doğrulanacak. Bu belge tek başına final SHA kanıtı değildir.

## Ayrılmış değişiklikler
- `test/ai08-enrollment-sandbox.test.ts`: revoke/machine/SID/session ve native sandbox deny-only
- `test/ai08-broker-receipt.test.ts`: imza kapsamı, ACK loss, input snapshot
- `test/ai08-wal-recycle.test.ts`: gerçek SQLite tarafından üretilen disposable reused WAL ve bozuk suffix/index
- `test/ai08-cas-scope.test.ts`: nested-scope snapshot, signed owner substitution, Broker readback race
- `test/ai08-mtls-pin.test.ts`: izole loopback TLS SPKI pin mismatch
- `docs/ai-handoff/AI-08/**`: kapsam, kanıt ve harici ihtiyaçlar

## Sıradaki işlem
1. Draft PR'ı sadece bu branch üzerinde oluştur; başka PR'a push/rebase/merge yapma.
2. Exact HEAD için tek CI run'ını izle, duplicate tetikleme.
3. Typecheck ve yeni QA testleri için ölçülmüş sonucu `TEST_EVIDENCE.md`/PR raporuyla eşleştir.
4. Fiziksel 2-PC kanıtı olmadıkça NO_GO; kaynak adaylarını production PASS olarak işaretleme.
