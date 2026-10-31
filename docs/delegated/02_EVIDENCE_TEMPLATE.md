# K03 — Kanıt ve teslim formatı

> Yardımcı geliştirici 1 · 2026-10-31T17:34:18+03:00 · main a19a228dc6f19fd484cf935e941a00ea625233f8 · dal docs/delegated-k-s1-20261031.
> Yalnız kaynak/doküman incelemesi; canlı cihaz veya servis deneyi yapılmadı.

## Her iş için zorunlu kayıt

~~~yaml
ID: S1-03-R01
source_issue: https://github.com/Naveax/Nexowire/issues/483
source_paths_and_symbols: []
branch: docs/delegated-k-s1-20261031
exact_SHA: UNKNOWN
command: NOT_RUN
exit_code: UNKNOWN
OS: UNKNOWN
datetime: UNKNOWN # ISO-8601 + timezone; Europe/Istanbul +03:00
expected: UNKNOWN
observed: UNKNOWN
result: NOT_RUN # PASS | FAIL | BLOCKED | PARTIAL | NOT_RUN | UNKNOWN
evidence_type: documentation # synthetic | local | CI | authorized-device
truth_level: source-only # test-only | merged | released | deployed | physical-verified
CI_ID: UNKNOWN
CI_workflow: UNKNOWN
CI_exact_SHA: UNKNOWN
CI_status_and_conclusion: UNKNOWN
blocker: UNKNOWN
PR_link: UNKNOWN
redaction_review: REQUIRED
~~~

Kaynak issue/dosya/sembol, beklenen ve gerçekten gözlenen ayrı yazılır. Test planında observed=NOT_RUN; expected bir PASS değildir. Queue/in_progress/cancelled/skipped veya eksik job başarılı sayılamaz. Önceki SHA'nın CI yeşili yeni HEAD'e devredilemez. Exit 0, transport ACK, Agent terminal metadata ve dış etkinin doğrulanması ayrı kanıtlardır.

## UNKNOWN / mutation kuralı

Kayıp ACK veya bağlantı/süreç değişimi sonrası mutation tekrar çalıştırılmaz. UNKNOWN terminal kayıt salt-okunur incelemeyle temizlenmez; yeni invocation ID ile dolaşılamaz. Agent succeeded metadata dış yan etkiyi kanıtlamaz. reconcileConnectionBoundAgentOperation automaticallyRetryable=false / externalSideEffectProven=false döndürebilir; Hub UNKNOWN korunur. Ayrı yetkili uzlaştırma kararı olmadan retry yok.

## Ana ekip talep kaydı

~~~yaml
request_ID: K-S1-REQ-XX
finding: UNKNOWN
source_issue: UNKNOWN
evidence_path_symbol_SHA: UNKNOWN
proposed_change: UNKNOWN
owner_and_target_path: UNKNOWN
acceptance_test: UNKNOWN
risk: UNKNOWN
status: PROPOSED_NOT_IMPLEMENTED
~~~

Yalnız bu yardımcının bulguları MAIN_TEAM_REQUESTS.md içine yazılır; diğer yardımcıları koordinatör birleştirir. Kapsam dışı kodu değiştirmek yerine kanıt/öneri bırakılır.

## Teslim kontrolü

K01–K03, S1-01–03 için yedi kaynaklı belge + yerel doküman doğrulaması + Draft PR veya dürüst erişim engeli/uygulanabilir diff gerekir. Senaryo planının tamamlanması senaryonun yürütüldüğü anlamına gelmez.

PR açıklaması: görev ID'leri, base main SHA, exact HEAD, yedi dosya, git diff --stat, komut+exit code, CI ID/exact SHA/state, sentetik/yerel/cihaz ayrımı, test edilmeyenler ve engeller. Kendi SHA'sı commit sonrasında PR açıklamasına konur. Draft bırak; merge/tag/release/deploy/dispatch/rerun yok.

Gerçek credential, cihaz UUID, e-posta, kullanıcı yolu/payload taşıma. fixture-device-a, fixture-device-b ve fixture-op-01 gibi sentetik adlar kullan. Kanıtsız PASS yasaktır.
