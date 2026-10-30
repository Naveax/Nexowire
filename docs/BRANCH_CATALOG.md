# Nexowire Branch Kataloğu ve Güvenli Temizlik Planı

> **30 Ekim 2026 snapshot.** Bu sayfa GitHub'daki branch/PR envanterini belgelemek içindir. Hiçbir branch silinmedi, PR birleştirilmedi ve CORE/Agent dağıtımı yapılmadı.

**Depo:** [Naveax/Nexowire](https://github.com/Naveax/Nexowire)  
**Denetlenen main SHA:** [`0242a29229953346f235a172213f59ce905ad89a`](https://github.com/Naveax/Nexowire/commit/0242a29229953346f235a172213f59ce905ad89a) (bu belge commit'inden önce)  
**Mevcut branch:** 381 (`main` dahil)  
**Açık PR:** 318  
**Kapanmış PR:** 632 (607 merged, 25 merged değil)

## 1. Kurallar ve kanıt düzeyleri

**KORU:** Açık PR HEAD'i veya açık PR'ın base branch'i. Draft, CI RED veya eski PR güncellemesi tek başına silme gerekçesi değildir.

**İNCELE:** PR'ı merged olan, merge olmadan kapanan veya açık PR bulunmayan dal. Bu etiket silinebilir demek değildir; `git merge-base`, `git log main..branch`, `git range-diff`, bağlı issue ve yayın referansları doğrulanmalıdır.

**48 saat kuralı:** 28 Ekim 2026 07:09 UTC ve sonrası değişen branch'lere dokunulmaz. Bu envanterde açık PR `updated_at` zamanları gösterilir. **PR tarihi branch commit tarihi değildir.** Kesin commit zamanı bütün branch'ler için çıkarılmadığından özellikle PR'siz dalların 48 saatten eski olduğu varsayılmaz.

**Tekrarlanan iş:** Aynı ad/konu eşdeğer kod anlamına gelmez. Exact HEAD SHA eşitliği dışında, kod karşılaştırması yapılmayan dal 'duplicate' olarak etiketlenmez.

**Production CORE:** Kaynak test PASS veya sentetik fixture, fiziksel Windows UAC/HIGH/Broker yetki kabulü değildir. CORE NO-GO ve korumalı test sınırları saklıdır.

## 2. Genel karar özeti

| Sınıf | Branch sayısı |
| --- | ---: |
| KORU / açık PR tabanı | 193 |
| KORU / PR incele | 115 |
| İNCELE / yetim veya eski | 27 |
| İNCELE / commit karşılaştır | 23 |
| KORU / güncel PR | 13 |
| İNCELE / merge sonrası | 9 |
| KORU | 1 |

## 3. Öncelikli iş paketleri

| Paket | Önemli PR'lar | Neyi çözüyor / neden ayrı tutulmalı? |
| --- | --- | --- |
| Windows kurulumu | [#971](https://github.com/Naveax/Nexowire/pull/971), [#972](https://github.com/Naveax/Nexowire/pull/972) | İlk PC OAuth/installer rehberi ve Agent Scheduled Task pil/UPS davranışı. Fiziksel kurulum ve source CI ayrıdır. |
| Agent WAL | [#954](https://github.com/Naveax/Nexowire/pull/954), [#957](https://github.com/Naveax/Nexowire/pull/957) | SQLite WAL tekrar kullanımı, startup fail-closed ve bağımsız QA. Tekrar gibi görünse de test ve düzeltme farklıdır. |
| CORE entegrasyonu | [#958](https://github.com/Naveax/Nexowire/pull/958), [#968](https://github.com/Naveax/Nexowire/pull/968) | Birden fazla güvenlik modülünün source entegrasyon adayları; doğrudan production onayı değildir. |
| CORE yetki ve kanıt | [#960](https://github.com/Naveax/Nexowire/pull/960), [#963](https://github.com/Naveax/Nexowire/pull/963), [#964](https://github.com/Naveax/Nexowire/pull/964), [#966](https://github.com/Naveax/Nexowire/pull/966), [#969](https://github.com/Naveax/Nexowire/pull/969), [#970](https://github.com/Naveax/Nexowire/pull/970) | Native session readback, kalıcı PostgreSQL dispatch, WebAuthn, imzalı manifest, approval ve mTLS enrollment. Ayrı trust boundary'ler. |
| UNKNOWN / revoke | [#953](https://github.com/Naveax/Nexowire/pull/953), [#956](https://github.com/Naveax/Nexowire/pull/956) | Kaybolan ACK / raporlama durumunda yerel STOP ve belirsiz işlemlerin korunması. |
| Kalite ve izlenebilirlik | [#539](https://github.com/Naveax/Nexowire/issues/539), [#780](https://github.com/Naveax/Nexowire/issues/780) | Merkezi reliability ve coding/task koordinasyonu. İş paketlerini kapatmadan önce issue kanıtlarını kontrol et. |

## 4. Güncel PR'lar (48 saat içinde PR etkinliği)

> Aşağıdaki zamanlar **PR güncellenme** zamanıdır; branch'in son commit tarihi yerine geçmez.

| PR | Branch | Güncelleme (UTC) |
| --- | --- | --- |
| [#971](https://github.com/Naveax/Nexowire/pull/971) | `fix/first-pc-onboarding-guide-20261029` | 2026-10-30 07:02 |
| [#973](https://github.com/Naveax/Nexowire/pull/973) | `feat/solkaun-unmetered-hosted-tool-credits-20261030` | 2026-10-29 21:55 |
| [#972](https://github.com/Naveax/Nexowire/pull/972) | `fix/agent-win-task-power-conditions-20261030` | 2026-10-29 21:30 |
| [#970](https://github.com/Naveax/Nexowire/pull/970) | `feat/core-native-enrollment-verifier-20261029` | 2026-10-29 20:23 |
| [#969](https://github.com/Naveax/Nexowire/pull/969) | `feat/core-durable-native-approval-20261029` | 2026-10-29 19:02 |
| [#968](https://github.com/Naveax/Nexowire/pull/968) | `integration/core-six-gates-candidate-20261029` | 2026-10-29 17:29 |
| [#966](https://github.com/Naveax/Nexowire/pull/966) | `feat/core-signed-runtime-manifest-20261029` | 2026-10-29 16:58 |
| [#964](https://github.com/Naveax/Nexowire/pull/964) | `feat/core-native-webauthn-approval-20261029` | 2026-10-29 16:58 |
| [#965](https://github.com/Naveax/Nexowire/pull/965) | `qa/core-windows-appcontainer-kernel-20261029` | 2026-10-29 16:49 |
| [#963](https://github.com/Naveax/Nexowire/pull/963) | `feat/core-postgres-dispatch-server-20261029` | 2026-10-29 16:49 |
| [#967](https://github.com/Naveax/Nexowire/pull/967) | `fix/core-appcontainer-profile-environment-20261029` | 2026-10-29 16:48 |
| [#962](https://github.com/Naveax/Nexowire/pull/962) | `fix/core-native-consent-immutable-20261029` | 2026-10-29 16:00 |
| [#961](https://github.com/Naveax/Nexowire/pull/961) | `fix/core-indefinite-idle-readiness-20261029` | 2026-10-29 12:19 |
| [#960](https://github.com/Naveax/Nexowire/pull/960) | `feat/core-native-session-readback-20261029` | 2026-10-29 11:52 |
| [#958](https://github.com/Naveax/Nexowire/pull/958) | `integration/core-p0-owner-candidates-20261029` | 2026-10-29 10:49 |
| [#959](https://github.com/Naveax/Nexowire/pull/959) | `qa/11-core-executor-broker-boundary-20261029` | 2026-10-29 10:47 |
| [#954](https://github.com/Naveax/Nexowire/pull/954) | `qa/11-journal-wal-recycle-20261029` | 2026-10-29 06:40 |
| [#957](https://github.com/Naveax/Nexowire/pull/957) | `fix/agent-wal-recycle-boundary-20261029` | 2026-10-29 06:40 |
| [#953](https://github.com/Naveax/Nexowire/pull/953) | `qa/11-core-unknown-completion-stop-20261028` | 2026-10-29 06:13 |
| [#956](https://github.com/Naveax/Nexowire/pull/956) | `fix/core-persistent-dispatch-fence-20261029` | 2026-10-29 06:12 |
| [#955](https://github.com/Naveax/Nexowire/pull/955) | `qa/11-run-pr-context-recheck-20261029` | 2026-10-29 05:52 |
| [#942](https://github.com/Naveax/Nexowire/pull/942) | `qa/11-pr-context-refs-20261028` | 2026-10-28 19:17 |
| [#943](https://github.com/Naveax/Nexowire/pull/943) | `qa/11-signed-receipt-aba-20261028` | 2026-10-28 19:17 |
| [#950](https://github.com/Naveax/Nexowire/pull/950) | `fix/02b-receipt-immutable-snapshot-aba-20261028` | 2026-10-28 19:12 |
| [#948](https://github.com/Naveax/Nexowire/pull/948) | `qa/11-windows-msvc-probe-warning-20261028` | 2026-10-28 18:21 |
| [#946](https://github.com/Naveax/Nexowire/pull/946) | `qa/11-dispatch-nested-scope-20261028` | 2026-10-28 18:21 |
| [#949](https://github.com/Naveax/Nexowire/pull/949) | `qa/11-core-d1-readiness-race-20261028` | 2026-10-28 18:21 |
| [#952](https://github.com/Naveax/Nexowire/pull/952) | `fix/02a-sedebug-unicode-token-readback-20261028` | 2026-10-28 18:21 |
| [#951](https://github.com/Naveax/Nexowire/pull/951) | `fix/04-claim-readiness-after-native-readback-20261028` | 2026-10-28 15:07 |
| [#916](https://github.com/Naveax/Nexowire/pull/916) | `fix/03-windows-core-dispatch-cas-seam-20261027` | 2026-10-28 14:26 |
| [#947](https://github.com/Naveax/Nexowire/pull/947) | `fix/01-immutable-dispatch-request-20261028` | 2026-10-28 13:38 |
| [#945](https://github.com/Naveax/Nexowire/pull/945) | `qa/11-dispatch-uuid-replay-20261028` | 2026-10-28 13:34 |
| [#944](https://github.com/Naveax/Nexowire/pull/944) | `qa/11-dispatch-request-mutation-20261028` | 2026-10-28 13:34 |
| [#936](https://github.com/Naveax/Nexowire/pull/936) | `qa/11-run-attempt-recheck-20261027-1949` | 2026-10-28 10:37 |

## 5. Bağımlılık haritası: açık PR base branch'leri

> Aktif child PR'ların tabanı olan dal, kendi PR'ı merged olsa da kullanılmaya devam edebilir. Bu yüzden korunur.

| Base | Açık child PR sayısı |
| --- | ---: |
| `test/qa27-windows-approval-native-witness-20261021` | 1 |
| `test/qa27-uac-remote-approval-20261021` | 1 |
| `test/qa27-remote-admin-provenance-followup-20261021` | 1 |
| `test/qa17-core-broker-adversarial-617-20261021` | 1 |
| `test/qa16-pr806-811-physical-proof-20261023` | 1 |
| `test/qa16-pr791-803-exact-proof-20261022` | 1 |
| `test/qa16-pr779-790-ci-provenance-20261022` | 1 |
| `test/qa16-pr774-780-p1-checklist-20261022` | 1 |
| `test/qa16-pr759-773-exact-evidence-20261022` | 1 |
| `test/qa16-pr747-758-exact-ci-20261022` | 1 |
| `test/qa16-pr730-745-docsonly-20261022` | 1 |
| `test/qa16-pr703-729-exact-ci-20261022` | 1 |
| `test/qa16-pr677-702-exact-ci-20261021` | 1 |
| `test/qa16-final-acceptance-refresh-20261018` | 1 |
| `test/qa-19-winjob-hosted-repro-20261021` | 1 |
| `test/parallel-15-s5-oct21-gzip-proof` | 1 |
| `test/parallel-15-s5-cancel-ack-fairness-20261021` | 1 |
| `test/parallel-15-s5-598-seeded-parser-20261021` | 1 |
| `test/parallel-15-s5-598-full-source-ci-20261021` | 1 |
| `test/parallel-14-quota-receipt-provenance-20261021` | 1 |
| `test/parallel-14-predispatch-unknown-20261021` | 3 |
| `test/parallel-14-crosshub-revoke-readback-20261021` | 1 |
| `test/parallel-14-core-quota-fencing-20261021` | 1 |
| `test/p05-verified-handle-acl-20261021` | 2 |
| `test/p05-native-relative-acl-20261021` | 2 |
| `test/p0-hyperv-elevation-evidence-617-20261021` | 1 |
| `test/integration-core618-qa619-20261021` | 1 |
| `test/29-native-receipt-verifier-617` | 1 |
| `test/29-elevated-audit-provenance-617` | 1 |
| `test/29-audit-rotation-crosshub-617` | 1 |
| `test/28-broker-crash-rollback-independent-qa-20261021` | 1 |
| `test/25-two-hub-cas-revoke-readback-20261022` | 1 |
| `test/25-signed-postcondition-root-boundary-20261021` | 1 |
| `test/25-postlaunch-revoke-ack-20261021` | 1 |
| `test/25-owner-revoke-mid-exec-20261021` | 1 |
| `test/25-late-permit-posteffect-unknown-20261022` | 1 |
| `test/25-crash-ack-root-readback-20261021` | 1 |
| `test/24-live-dag-drift-gates-20261021` | 1 |
| `test/24-live-dag-77-merge-evidence-20261021` | 1 |
| `test/24-integration-dag-provenance-20261021` | 1 |
| `test/24-full-open-dag-104-sha-20261021` | 1 |
| `test/24-delta-791-803-paged-source-20261022` | 2 |
| `test/24-delta-781-790-source-20261022` | 1 |
| `test/24-delta-774-779-source-20261022` | 1 |
| `test/24-delta-759-773-exact-20261022` | 1 |
| `test/22-crosshub-repair-publish-20261021` | 1 |
| `test/22-crosshub-fencing-20261021` | 1 |
| `test/21-isolated-integration-768-770-20261022` | 1 |
| `test/20-signed-broker-installer-negative-qa-20261021` | 1 |
| `test/13-wss-keyrotate-owner-revoke-20261021` | 1 |
| `test/10-broker-filetime-on-709-20261022` | 2 |
| `test/09-private-job-compat-20261021` | 1 |
| `test/09-private-child-receipt-emergency-stop-20261021` | 1 |
| `test/09-core-broker-no-gui-escape-20261021` | 1 |
| `test/09-cdp-step-owner-drift-20261022` | 1 |
| `test/09-cdp-micro-scenario-contract-20261022` | 1 |
| `test/09-ai-screen-creationtime-owner-fence-20261021` | 1 |
| `test/09-750-platform-owner-blocked-20261022` | 1 |
| `test/07-oauth-hostile-state-rotation-20261021` | 1 |
| `test/07-oauth-csrf-state-consume-20261021` | 1 |
| `test/06-runbook-task-graph-alias-negative-20261023` | 1 |
| `test/06-reconnect-epoch-no-replay-20261021` | 1 |
| `test/06-journal-634-failclosed-20261021` | 1 |
| `test/06-754-final-publish-proof-20261022` | 1 |
| `test/06-742-orphan-status-no-replay-20261022` | 1 |
| `test/06-725-712-double-reconnect-20261022` | 2 |
| `test/06-691-predispatch-reopen-20261021` | 1 |
| `test/03-709-qa17-qa19-integration-20261022` | 4 |
| `test/02-medium-high-token-evidence-20261027` | 1 |
| `test/02-broker-native-truth-negative-20261021` | 1 |
| `security/07-oauth-issuer-fence-browser-revoke-20261021` | 1 |
| `security/07-oauth-atomic-access-verifier-20261022` | 1 |
| `qa/worker30-stalled-gzip-quiet-isolation-20261021` | 1 |
| `qa/worker30-next-compressed-fairness-cancel-20261021` | 1 |
| `qa/worker30-monotonic-publish-quota-hold-20261022` | 1 |
| `qa/worker30-gzip95-tenant-memory-20261021` | 1 |
| `qa/core-windows-appcontainer-kernel-20261029` | 2 |
| `qa/23-effective-owner669-negative-20261021` | 1 |
| `qa/18-runbook-clone-unknown-replay-20261022` | 1 |
| `qa/18-final-dispatch-check-crosshub-20261022` | 1 |
| `qa/18-crosshub-pending-permit-after-revoke-20261022` | 1 |
| `qa/18-antirollback-cas-hostile-20261021` | 1 |
| `qa/11-windows-msvc-probe-warning-20261028` | 1 |
| `qa/11-windows-broker-ci-20261027` | 1 |
| `qa/11-signed-receipt-aba-20261028` | 1 |
| `qa/11-run-attempt-recheck-20261027-1949` | 1 |
| `qa/11-pr-context-refs-20261028` | 1 |
| `qa/11-offline-ci-boundaries-20261027` | 1 |
| `qa/11-live-github-ci-evidence-20261027` | 1 |
| `qa/11-journal-wal-recycle-20261029` | 1 |
| `qa/11-dispatch-uuid-replay-20261028` | 1 |
| `qa/11-dispatch-request-mutation-20261028` | 1 |
| `qa/11-dispatch-nested-scope-20261028` | 1 |
| `qa/11-core-unknown-completion-stop-20261028` | 1 |
| `qa/11-core-executor-broker-boundary-20261029` | 1 |
| `qa/11-core-d1-readiness-race-20261028` | 1 |
| `qa/11-core-ci-source-evidence-boundary-20261027` | 1 |
| `qa/11-checkout-case-evidence-20261027` | 1 |
| `integration/core-six-gates-candidate-20261029` | 1 |
| `integration/core-p0-owner-candidates-20261029` | 1 |
| `fix/windows-job-helper-trust-qa-20261018` | 4 |
| `fix/parallel-05-scoped-path-usb-grants-20261018` | 1 |
| `fix/parallel-04-access-core-adminbridge-20261018` | 1 |
| `fix/p0-agent-journal-antirollback-20261019` | 1 |
| `fix/mcp-http-body-cap-588-20261020` | 4 |
| `fix/core-native-consent-immutable-20261029` | 2 |
| `fix/core-indefinite-idle-readiness-20261029` | 1 |
| `fix/31-scoped-git-executor-20261022` | 4 |
| `fix/13-owner-wss-receipt-replay-20261021` | 1 |
| `fix/12-signed-release-dag-permit-v2-20261022` | 1 |
| `fix/12-signed-bootstrap-owner-20261021` | 3 |
| `fix/12-native-acl-dispatch-permit-source-20261022` | 2 |
| `fix/12-import-dag-repair-bootstrap-20261021` | 3 |
| `fix/12-import-ancestor-inventory-exact-20261022` | 1 |
| `fix/12-atomic-switch-repair-20261021` | 2 |
| `fix/09-private-runtime-owner-failclosed-20261021` | 1 |
| `fix/09-private-picker-owner-witness-20261022` | 1 |
| `fix/09-private-emergency-preflight-fence-20261022` | 1 |
| `fix/09-ai-screen-additional-gui-broker-20261020` | 1 |
| `fix/09-759-stop-missing-state-unknown-20261022` | 1 |
| `fix/08-unresolved-publish-resume-20261022` | 1 |
| `fix/08-predispatch-cancel-fence-20261021` | 2 |
| `fix/08-forged-receipt-late-cancel-20261021` | 2 |
| `fix/08-final-monotonic-20261022` | 2 |
| `fix/08-checkpoint-final-race-20261022` | 3 |
| `fix/08-checkpoint-external-commit-20261022` | 3 |
| `fix/08-cancel-native-dispatch-race-20261021` | 2 |
| `fix/06-transfer-grant-epoch-followup-20261021` | 1 |
| `fix/04-core-console-enrollment-once-20261027` | 1 |
| `fix/04-claim-readiness-after-native-readback-20261028` | 1 |
| `fix/03-windows-broker-provider-attestation-20261021` | 4 |
| `fix/03-strict-json-v1-native-boundary-20261022` | 1 |
| `fix/03-protected-tree-hosted-path-binding-20261021` | 3 |
| `fix/03-protected-broker-tree-and-pid-gate-20261021` | 3 |
| `fix/03-native-effective-acl-pid-dup-20261022` | 1 |
| `fix/03-durable-nwjob5-early-output-20261023` | 3 |
| `fix/03-829-strict-json-physical-seam-20261023` | 1 |
| `fix/02b-windows-broker-privileged-fixture-20261027` | 2 |
| `fix/02b-receipt-post-verify-recheck-20261028` | 1 |
| `fix/02b-effect-admission-monotonic-expiry-20261028` | 1 |
| `fix/02b-broker-health-true-token-evidence-20261028` | 1 |
| `fix/02b-broker-admission-challenge-bound-effects-20261027` | 1 |
| `fix/02a-job-handle-post-attestation-seal-20261027` | 1 |
| `fix/02-windows-job-owner-dacl-trust-20261027` | 1 |
| `fix/02-job-dup-handle-mic-guard-20261027` | 1 |
| `fix/02-broker-server-effect-admission-20261027` | 1 |
| `fix/01-witness-owner-epoch-20261021` | 1 |
| `fix/01-witness-delegation-20261021` | 2 |
| `fix/01-runbook-native-admission-failclosed-20261023` | 4 |
| `fix/01-monotonic-remote-trust-20261020` | 1 |
| `fix/01-grant-transition-snapshot-20261027` | 1 |
| `fix/01-grant-cas-response-challenge-20261027` | 2 |
| `fix/01-dispatch-monotonic-deadlines-20261027` | 2 |
| `fix/01-broker-revoke-freshness-drain-20261027` | 1 |
| `fix/01-broker-reserve-lost-ack-contract-20261027` | 2 |
| `fix/01-broker-release-owner-scoped-20261027` | 4 |
| `fix/01-broker-dispatch-wire-boundary-20261027` | 1 |
| `fix/01-broker-dispatch-nonce-epoch-20261021` | 2 |
| `fix/01-broker-dispatch-external-fence-20261021` | 4 |
| `fix/01-broker-dispatch-expiry-after-readback-20261027` | 1 |
| `fix/01-broker-dispatch-clock-validation-20261027` | 1 |
| `fix/01-bound-grant-monotonic-cas-20261021` | 2 |
| `feat/parallel-14-trusted-cleanup-admission-20261021` | 1 |
| `feat/parallel-12-agent-lifecycle-onboarding-20261018` | 1 |
| `feat/parallel-10-broker-preflight-20261021` | 1 |
| `feat/parallel-08-store-job-failclosed-20261021` | 1 |
| `feat/parallel-08-large-artifact-588-20261020` | 1 |
| `feat/core-signed-runtime-manifest-20261029` | 1 |
| `feat/core-native-webauthn-approval-20261029` | 1 |
| `feat/core-native-session-readback-20261029` | 1 |
| `feat/core-durable-native-approval-20261029` | 1 |
| `feat/33-bounded-task-loop-engine-20261023` | 1 |
| `feat/32-reviewed-git-patch-20261023` | 2 |
| `feat/12-core-bootstrap-delegation-20261021` | 4 |
| `feat/08-publish-receipt-20261022` | 3 |
| `feat/08-mutation-fence-20261021` | 4 |
| `feat/08-issuer-fixture-contract-20261022` | 1 |
| `feat/07-oauth-epoch-refresh-service-adapter-20261022` | 1 |
| `feat/04-task-worktree-unknown-scope-20261022` | 1 |
| `feat/04-nonce-native-cas-readback-20261022` | 1 |
| `feat/04-late-permit-effective-20261022` | 1 |
| `feat/04-final-identity-binding-20261022` | 1 |
| `feat/04-final-dispatch-grant-20261022` | 1 |
| `feat/04-diff-approval-authority-20261022` | 1 |
| `feat/04-core-effective-authority-20261021` | 2 |
| `feat/04-core-delegation-617` | 1 |
| `feat/04-active-job-auth-fence-20261021` | 1 |
| `feat/03-hyperv-typed-gate-617` | 1 |
| `feat/03-core-executor-gates-617` | 4 |
| `docs/12-self-host-worker-install-acceptance-20261022` | 1 |
| `docs/12-self-host-worker-deployment-identity-20261022` | 1 |
| `docs/03-task-sandbox-780-feasibility-20261022` | 1 |
| `docs/01-agent-loop-journal-contract-20261022` | 2 |

**Açık PR olup aktif branch envanterinde HEAD bulunmayan:** 0.


## 6. Exact SHA eşitliği (isim benzerliği değil)

Mevcut dallar arasında aynı PR HEAD commit'ine işaret eden **0 grup** görüldü. Bu eşitlik dahi bağımlılık kontrolü yapılmadan silme izni değildir.

Eşit HEAD SHA'lı çoklu dal yok.

## 7. Mevcut branch'lerin tam envanteri

> **PR / amaç:** PR bağlantısı varsa gerçek GitHub PR başlığından alınır. PR bulunmazsa yalnızca isimden çıkarılmış bir konu açıklamasıdır. `İNCELE` otomatik silme anlamına gelmez.

### QA / CI / adversarial test (215)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `ci/wsl2-real-integration-v1` | *İsimden:* wsl2 real integration v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `docs/qa49-release-acceptance-r01-r22-20261023` | [#823](https://github.com/Naveax/Nexowire/pull/823) docs(qa49): independent R01–R22/P1 physical release acceptance NO_GO and rol… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `feat/04-synthetic-status-fail-close-20261023` | [#844](https://github.com/Naveax/Nexowire/pull/844) fix(p0): never display CORE VERIFIED from synthetic Journal/Audit/client sta… | MERGE olmadan kapanmış PR | PR 2026-10-26 | **İNCELE / commit karşılaştır** |
| `feat/35-pairing-writer-authority-contract-20261023` | [#818](https://github.com/Naveax/Nexowire/pull/818) security(#35): fail-closed WSS pairing writer contract and two-Hub adversari… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `feat/audit-history-v1` | [#45](https://github.com/Naveax/Nexowire/pull/45) Add bounded persistent audit history queries | MERGE olmadan kapanmış PR | PR 2026-09-30 | **İNCELE / commit karşılaştır** |
| `feature/42-worker-reconnect-lease-fence-20261023` | [#819](https://github.com/Naveax/Nexowire/pull/819) feat(p1 #42): isolated worker reconnect lease fencing contract and negative … | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `fix/02-broker-acl-delete-child-20261024` | [#856](https://github.com/Naveax/Nexowire/pull/856) fix(p0 #02): include DELETE_CHILD-only ancestor ACE in read-only Broker ACL … | MERGE olmadan kapanmış PR | PR 2026-10-26 | **İNCELE / commit karşılaştır** |
| `qa/05-loop-unknown-precedence-20261024` | [#853](https://github.com/Naveax/Nexowire/pull/853) fix(#05): make restored external UNKNOWN sticky ahead of stale grant/scope S… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `qa/06-813-836-head-crossrun-20261024` | [#854](https://github.com/Naveax/Nexowire/pull/854) test(qa06): unchanged #836 undo negatives against #813 current source | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `qa/10-847-current-826-byte-identical-20261024` | [#855](https://github.com/Naveax/Nexowire/pull/855) test(qa10): unchanged #847 direct graph UNKNOWN negative on current #826 | AÇIK PR (Draft) | PR 2026-10-24 | **KORU / PR incele** |
| `qa/10-core-adversarial-reattest-20261027` | [#908](https://github.com/Naveax/Nexowire/pull/908) test(p0): adversarial stale HIGH-token readback during external CAS (#702) | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `qa/10-core-dispatch-926-20261027` | [#927](https://github.com/Naveax/Nexowire/pull/927) test(p0): unchanged #908 + independent #926 monotonic/ACK/revoke negatives | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `qa/10-grant-cas-925-20261027` | [#928](https://github.com/Naveax/Nexowire/pull/928) test(p0): independent #925 stale grant CAS nonce replay checks | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `qa/11-bound-windows-dpapi-ci-stage-20261028` | [#941](https://github.com/Naveax/Nexowire/pull/941) ci(#11): bound hosted Windows DPAPI/pre-logon step without skipping tests | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `qa/11-checkout-case-evidence-20261027` | [#934](https://github.com/Naveax/Nexowire/pull/934) fix(qa #11): distinguish checkout and case evidence | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-core-ci-source-evidence-boundary-20261027` | [#912](https://github.com/Naveax/Nexowire/pull/912) test(qa11): exact-SHA CI evidence audit and CORE physical NO-GO boundary | MERGED PR geçmişi · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `qa/11-core-d1-readiness-race-20261028` | [#949](https://github.com/Naveax/Nexowire/pull/949) test(#11): expose CORE claim readiness races | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-core-executor-broker-boundary-20261029` | [#959](https://github.com/Naveax/Nexowire/pull/959) test(qa): distinguish executor hard stop from Broker HTTP admission | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `qa/11-core-unknown-completion-stop-20261028` | [#953](https://github.com/Naveax/Nexowire/pull/953) test(#11): expose missing local STOP when UNKNOWN reporting fails | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `qa/11-dispatch-nested-scope-20261028` | [#946](https://github.com/Naveax/Nexowire/pull/946) test(#11): expose nested owner and session substitution | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-dispatch-request-mutation-20261028` | [#944](https://github.com/Naveax/Nexowire/pull/944) test(#11): expose mutable dispatch request substitution | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-dispatch-uuid-replay-20261028` | [#945](https://github.com/Naveax/Nexowire/pull/945) test(#11): expose request UUID replacement after lost ACK | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-journal-wal-recycle-20261029` | [#954](https://github.com/Naveax/Nexowire/pull/954) test(#11): reproduce valid recycled WAL blocking Agent startup | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `qa/11-live-github-ci-evidence-20261027` | [#920](https://github.com/Naveax/Nexowire/pull/920) test(qa11): verify live exact-head GitHub CI evidence | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `qa/11-offline-ci-boundaries-20261027` | [#935](https://github.com/Naveax/Nexowire/pull/935) fix(qa #11): preserve offline CI evidence boundaries | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-pr-context-refs-20261028` | [#942](https://github.com/Naveax/Nexowire/pull/942) fix(qa): bind CI evidence to PR branch identity | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-run-attempt-recheck-20261027-1949` | [#936](https://github.com/Naveax/Nexowire/pull/936) fix(qa): recheck PR and CI run after reading attempt jobs | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-run-pr-context-recheck-20261029` | [#955](https://github.com/Naveax/Nexowire/pull/955) fix(qa #11): recheck selected PR association after job retrieval | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `qa/11-signed-receipt-aba-20261028` | [#943](https://github.com/Naveax/Nexowire/pull/943) test(#11): expose signed receipt mutation-and-restore race | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-system-ci-r01-r22-20261024` | [#861](https://github.com/Naveax/Nexowire/pull/861) docs(qa11): exact-head CI failure matrix, NWJOB5 ancestry and R01-R22 gate | AÇIK PR (Draft) | PR 2026-10-24 | **KORU / PR incele** |
| `qa/11-windows-broker-ci-20261027` | [#933](https://github.com/Naveax/Nexowire/pull/933) test(ci #11): require Windows Broker fixture coverage | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/11-windows-msvc-probe-warning-20261028` | [#948](https://github.com/Naveax/Nexowire/pull/948) test(#11): reject Windows Job probe C4133 warning | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `qa/18-antirollback-cas-hostile-20261021` | [#637](https://github.com/Naveax/Nexowire/pull/637) test(p0): #18 hostile external CAS, journal restore and CORE/ROOT epoch QA | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `qa/18-bound-grant-rollback-timestamp-20261021` | [#680](https://github.com/Naveax/Nexowire/pull/680) test(p0): #18 independently challenge #676 atomic revoke, rollback and signe… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/18-cloned-worktree-source-sha-unknown-20261022` | [#794](https://github.com/Naveax/Nexowire/pull/794) test(p0): #18 cloned worktree source SHA drift across lost-ACK UNKNOWN and r… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/18-crossbroker-revoke-drain-20261021` | [#710](https://github.com/Naveax/Nexowire/pull/710) test(p0): #18 cross-Broker revokeAndDrain, signed permit replay and witness … | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/18-crosshub-pending-permit-after-revoke-20261022` | [#731](https://github.com/Naveax/Nexowire/pull/731) test(p0): #18 cross-Hub late signed permit during stalled revokeAndDrain | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `qa/18-crossrun-781-on-826-20261023` | [#840](https://github.com/Naveax/Nexowire/pull/840) test(p0/qa18): replay byte-identical #781 UNKNOWN clone hostile negative on … | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/18-external-commit-cas-linearization-20261022` | [#764](https://github.com/Naveax/Nexowire/pull/764) test(p0): #18 external reserve→commit dispatch CAS vs revoke-start and UNKNO… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/18-final-dispatch-check-crosshub-20261022` | [#747](https://github.com/Naveax/Nexowire/pull/747) test(p0): #18 final native CAS check after cross-Hub late permit vs revoke-s… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `qa/18-migration-rollback-crosshub-20261021` | [#659](https://github.com/Naveax/Nexowire/pull/659) test(p0): #18 cross-Hub migration/revoke CAS races and crash-WAL negatives | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/18-runbook-clone-unknown-replay-20261022` | [#781](https://github.com/Naveax/Nexowire/pull/781) test(p0): #18 lost mutation ACK misclassified and cloned durable runbook red… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `qa/18-temp-base-826-aabc-20261023` | *İsimden:* 18 temp base 826 aabc | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `qa/18-temp-cross-781-847-on-826-aabc-20261023` | [#849](https://github.com/Naveax/Nexowire/pull/849) TEMP / CI ONLY #18 cross-run unchanged #781 + #847 on exact #826 aabc75fd | MERGE olmadan kapanmış PR | PR 2026-10-23 | **İNCELE / commit karşılaştır** |
| `qa/23-core-effective-ui-status-20261021` | [#642](https://github.com/Naveax/Nexowire/pull/642) test(p0): independent CORE effective UI status and signed evidence QA (#322 … | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/23-effective-owner669-negative-20261021` | [#686](https://github.com/Naveax/Nexowire/pull/686) test(p0): #23 independent signed CORE EFFECTIVE UI regressions against #669 | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `qa/23-ui-native-cas-reconnect-20261021` | [#726](https://github.com/Naveax/Nexowire/pull/726) test(p0): #23 reconnect anti-replay and native HIGH/CAS UI fail-close QA (#6… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `qa/31-845-windows-temp-20261023` | *İsimden:* 31 845 windows temp | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `qa/47-twohub-cas-revoke-hostile-20261023` | [#824](https://github.com/Naveax/Nexowire/pull/824) test(qa47): independent two-Hub CAS/revoke hostile schedules and UNKNOWN vis… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/core-windows-appcontainer-kernel-20261029` | [#965](https://github.com/Naveax/Nexowire/pull/965) test(core): add real Windows AppContainer kernel diagnostic with fixed test … | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `qa/p46-780-task-sandbox-cross-platform-red-20261023` | [#832](https://github.com/Naveax/Nexowire/pull/832) test(qa46 #780): RED Windows/Linux task sandbox OS boundary acceptance | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/w26-743-json-version-type-20261022` | [#753](https://github.com/Naveax/Nexowire/pull/753) test(p0 #26): strict JSON v1 type confusion negative against #743, no native… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/w26-780-worktree-root-escape-20261022` | [#786](https://github.com/Naveax/Nexowire/pull/786) test(qa26 #780): Git linked-worktree root outside scoped workspace must deny | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/w26-811-commitgraph-nofollow-20261023` | [#845](https://github.com/Naveax/Nexowire/pull/845) test(qa26 #780): nested Git commit-graph file symlink fail-closed with healt… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `qa/w26-native-handle-provenance-20261021` | [#647](https://github.com/Naveax/Nexowire/pull/647) test(p0): independent native Windows handle provenance negatives (W26) | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/w26-native-handle-volume-v2-20261021` | [#657](https://github.com/Naveax/Nexowire/pull/657) test(p0): Windows handle final-volume provenance, alias grant and short-read… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/w26-p673-handle-import-negative-20261021` | [#694](https://github.com/Naveax/Nexowire/pull/694) test(p0 #26): hostile native handle rename and protected DLL-import provenan… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/w26-p690-import-dag-20261021` | [#723](https://github.com/Naveax/Nexowire/pull/723) test(p0 #26): transitive updater DLL signer/hash/handle negatives against #6… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/w26-p707-intermediate-ancestor-acl-20261022` | [#737](https://github.com/Naveax/Nexowire/pull/737) test(p0 #26): independent imported relative-ancestor ACL witness gap against… | MERGE olmadan kapanmış PR | PR 2026-10-21 | **İNCELE / commit karşılaştır** |
| `qa/worker30-bounded-parser-fairness-20261021` | [#649](https://github.com/Naveax/Nexowire/pull/649) test(qa30): deterministic bounded parser, tenant fairness and pending-chunk … | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `qa/worker30-final-receipt-quota-unknown-20261022` | [#766](https://github.com/Naveax/Nexowire/pull/766) test(qa30): final publish receipt is not writer-stop or quota release after … | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/worker30-gzip95-tenant-memory-20261021` | [#693](https://github.com/Naveax/Nexowire/pull/693) test(qa30): full 4x9.5MiB gzip parser isolation and pending-receipt memory f… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `qa/worker30-monotonic-publish-quota-hold-20261022` | [#774](https://github.com/Naveax/Nexowire/pull/774) test(qa30): independently committed publication cannot release tenant UNKNOW… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `qa/worker30-next-compressed-fairness-cancel-20261021` | [#660](https://github.com/Naveax/Nexowire/pull/660) test(qa30-next): compressed response provenance, seeded small-queue fairness… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `qa/worker30-runbook-clone-unknown-escrow-20261022` | [#791](https://github.com/Naveax/Nexowire/pull/791) test(qa30): cloned UNKNOWN runbook double-charges staging while quiet share … | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/worker30-single-slot-close-barrier-20261022` | [#735](https://github.com/Naveax/Nexowire/pull/735) test(qa30): single witnessed parser-slot release under noisy gzip admission | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/worker30-stalled-gzip-quiet-isolation-20261021` | [#724](https://github.com/Naveax/Nexowire/pull/724) test(qa30): quiet compressed-admission starvation and re-pair pending witnes… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `qa/worker30-strict-logical-clone-burst-20261023` | [#835](https://github.com/Naveax/Nexowire/pull/835) test(qa30): 32 hostile cloned logical admissions keep UNKNOWN escrow and qui… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `qa/worker30-task-budget-unknown-fairness-20261022` | [#784](https://github.com/Naveax/Nexowire/pull/784) test(qa30): bounded P1 worker task quotas, quiet tiny share and UNKNOWN escr… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa/worker30-unchanged-791-on-718-20261022` | [#806](https://github.com/Naveax/Nexowire/pull/806) test(qa30): unchanged #791 hostile UNKNOWN clone against #718 quota API (com… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `qa/worker39-tenant-loop-cross-boundary-20261023` | [#817](https://github.com/Naveax/Nexowire/pull/817) test(qa39): tenant fairness + fail-closed admission and RED cloned UNKNOWN d… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `qa41/selfhost-worker-signing-packaging-20261023` | [#827](https://github.com/Naveax/Nexowire/pull/827) test(qa41): independent self-host worker signing and packaging negatives | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/02-broker-native-truth-negative-20261021` | [#683](https://github.com/Naveax/Nexowire/pull/683) test(p0): #670 native Broker witness, physical UAC, epoch and persistent UNK… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/02-core-633-elevated-error-qa-20261021` | [#661](https://github.com/Naveax/Nexowire/pull/661) test(p0): independent CORE elevated requestId, owner epoch and UNKNOWN postc… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/02-dpapi-683-failclosed-isolation-20261021` | [#727](https://github.com/Naveax/Nexowire/pull/727) test(qa): isolate #683 hosted CurrentUser DPAPI timeout and preserve CORE UN… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/02-error-576-integrated-proof-20261021` | [#609](https://github.com/Naveax/Nexowire/pull/609) test(qa): unchanged #599 Error Contract and Windows stream ordering on #576 … | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/02-error-ordering-negative-20261020` | [#599](https://github.com/Naveax/Nexowire/pull/599) test(p0): Error Contract mutation no-replay and Windows output ordering nega… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/02-medium-high-token-evidence-20261027` | [#917](https://github.com/Naveax/Nexowire/pull/917) test(#02): attest true medium attacker and high Job guardian kernel tokens b… | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `test/03-709-qa17-qa19-integration-20261022` | [#743](https://github.com/Naveax/Nexowire/pull/743) test(p0): integrate unchanged #705/#717 Windows QA with #709 fail-closed tre… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/06-691-predispatch-reopen-20261021` | [#703](https://github.com/Naveax/Nexowire/pull/703) test(connection): reopen UNKNOWN and quarantine #691 undispatched intent | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/06-725-712-double-reconnect-20261022` | [#742](https://github.com/Naveax/Nexowire/pull/742) test(connection): preserve forensic UNKNOWN and nonce-fence owner epochs acr… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/06-742-orphan-status-no-replay-20261022` | [#752](https://github.com/Naveax/Nexowire/pull/752) fix(connection): keep orphan UNKNOWN fail-closed across reconnect (#725) | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/06-754-final-publish-proof-20261022` | [#770](https://github.com/Naveax/Nexowire/pull/770) test(connection): independently verify final Native receipt after reconnect … | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/06-781-cloned-id-epoch-audit-20261022` | [#796](https://github.com/Naveax/Nexowire/pull/796) test(connection): expose cloned runbook UNKNOWN correlation boundary (#781) | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/06-journal-634-failclosed-20261021` | [#666](https://github.com/Naveax/Nexowire/pull/666) test(connection): fail-closed #634 worker and #613 journal reconciliation | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/06-next4-exact847-replay-on-aabc75fd-20261023` | [#848](https://github.com/Naveax/Nexowire/pull/848) TEMP #06: byte-identical #847 replay on updated #826 source | MERGE olmadan kapanmış PR | PR 2026-10-23 | **İNCELE / commit karşılaştır** |
| `test/06-reconnect-epoch-no-replay-20261021` | [#695](https://github.com/Naveax/Nexowire/pull/695) test(connection): fence reconnect epoch after lost ACK readback (#667) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/06-runbook-task-graph-alias-negative-20261023` | [#843](https://github.com/Naveax/Nexowire/pull/843) test(connection): expose direct task.graph.run alias outside #826 runbook de… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `test/06-task-graph-unknown-deny-red-20261023` | [#847](https://github.com/Naveax/Nexowire/pull/847) test(connection): RED require zero direct graph dispatch after original UNKN… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/07-oauth-csrf-state-consume-20261021` | [#675](https://github.com/Naveax/Nexowire/pull/675) security(oauth/#07): browser-bound one-time GitHub CSRF state with durable C… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/07-oauth-hostile-state-rotation-20261021` | [#697](https://github.com/Naveax/Nexowire/pull/697) test(oauth/#07): cross-session CAS, key rotation, abandoned tab and refresh-… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/08-cdp-navigation-observation-no-replay-20261024` | [#858](https://github.com/Naveax/Nexowire/pull/858) test(ai-screen): fail closed on CDP lost ACK, redirect and emergency stop (#… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/09-750-platform-owner-blocked-20261022` | [#759](https://github.com/Naveax/Nexowire/pull/759) test(p0): fix Linux picker owner negative and document #756/#757 BLOCKED | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/09-ai-screen-creationtime-owner-fence-20261021` | [#663](https://github.com/Naveax/Nexowire/pull/663) test(p0): AI Screen PID creationTime and verified Job owner fence (#402) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/09-cdp-micro-scenario-contract-20261022` | [#801](https://github.com/Naveax/Nexowire/pull/801) test(p1): bound existing CDP micro-scenario plan, deny task dispatch (#780) | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/09-cdp-step-owner-drift-20261022` | [#805](https://github.com/Naveax/Nexowire/pull/805) test(p1): stop CDP next step on owner/worktree drift or UNKNOWN (#780) | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `test/09-core-broker-no-gui-escape-20261021` | [#624](https://github.com/Naveax/Nexowire/pull/624) test(p0): CORE signed-Broker boundary and headless-safe private GUI/UAC nega… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/09-private-child-receipt-emergency-stop-20261021` | [#692](https://github.com/Naveax/Nexowire/pull/692) test(p0): fail-close forged private child launch and emergency-stop races (#… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/09-private-job-compat-20261021` | [#611](https://github.com/Naveax/Nexowire/pull/611) test(p0): AI Screen #602 + Windows Job #576 provenance and picker fail-close | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/10-broker-filetime-on-709-20261022` | [#733](https://github.com/Naveax/Nexowire/pull/733) test(p0): re-run CORE Broker FILETIME/CAS QA on protected-tree #709 with una… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/10-public-core-readout-provider-cas-negative-20261022` | [#771](https://github.com/Naveax/Nexowire/pull/771) test(p0): RED public CORE readout distinguishes native UNAVAILABLE, installe… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/10-task-sandbox-readonly-inventory-20261022` | [#782](https://github.com/Naveax/Nexowire/pull/782) test(p1): truthful task sandbox disk/platform/isolation/remote preflight inv… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/13-wss-keyrotate-owner-revoke-20261021` | [#701](https://github.com/Naveax/Nexowire/pull/701) test(s2): fence stale owner WSS pairing receipts on signer and owner rotation | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/13-wss-pairing-replace-replay-20261021` | [#720](https://github.com/Naveax/Nexowire/pull/720) fix(s2): revoke stale WSS receipt on device pairing REPLACE or DELETE | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/13-wss-revocation-regression-20261021` | [#612](https://github.com/Naveax/Nexowire/pull/612) fix(s2): bind signed device enrollment and nonce across async owner authenti… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/20-780-git-fsmonitor-hook-escape-20261022` | [#800](https://github.com/Naveax/Nexowire/pull/800) test(qa20 #780): RED workspace.snapshot Git fsmonitor hook escapes scoped ta… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/20-agent105-preswitch-repair-qa-20261021` | [#706](https://github.com/Naveax/Nexowire/pull/706) test(QA #20): #696 nested updater DLL, revoked DPAPI and Agent 1.0.5 pre-swi… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/20-deep-dll-rollback-epoch-qa-20261022` | [#732](https://github.com/Naveax/Nexowire/pull/732) test(QA #20): #714 deep transitive DLL publisher/hash and Agent 1.0.5 re-pai… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/20-install-manifest-chain-source-qa-20261021` | [#655](https://github.com/Naveax/Nexowire/pull/655) test(QA #20): independently signed installer import-chain and Agent 1.0.5 ro… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/20-owner-stage-repair-crash-negative-20261021` | [#678](https://github.com/Naveax/Nexowire/pull/678) test(QA #20): signed nested import publisher, revoked re-pair DPAPI and cras… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/20-signed-broker-installer-negative-qa-20261021` | [#639](https://github.com/Naveax/Nexowire/pull/639) test(QA #20): hostile signed Broker installer and CORE delegation negatives | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/21-785-checkpoint-readback-races-20261022` | [#799](https://github.com/Naveax/Nexowire/pull/799) test(p0): #785 external checkpoint CAS high-water/owner revoke/UNKNOWN negat… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/21-artifact-cancel-postchunk-ack-status-20261021` | [#651](https://github.com/Naveax/Nexowire/pull/651) test(p0): post-chunk cancellation, forged ACK and concurrent status acceptan… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/21-artifact-cancel-read-gates-20261021` | [#640](https://github.com/Naveax/Nexowire/pull/640) test(p0): gated Artifact source-read/cancel and write-dispatch races (#588) | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/21-external-witness-rollback-742-20261022` | [#751](https://github.com/Naveax/Nexowire/pull/751) test(p0): external durable owner witness rejects journal rollback and stale … | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/21-final-receipt-owner-rollback-20261022` | [#762](https://github.com/Naveax/Nexowire/pull/762) test(p0): external owner rollback and authenticated final SHA / forged ACK g… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/21-isolated-integration-768-770-20261022` | *İsimden:* 21 isolated integration 768 770 | EŞLEŞEN PR YOK · **child base** | commit tarihi doğrulanmadı | **KORU / açık PR tabanı** |
| `test/21-qa-768-770-issuer-cas-20261022` | [#776](https://github.com/Naveax/Nexowire/pull/776) test(p0): unchanged #762 + independent issuer/current-owner CAS/Connection w… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/21-qa640-651-on-667-20261021` | [#677](https://github.com/Naveax/Nexowire/pull/677) test(p0): replay unchanged #640/#651 and reopened UNKNOWN journal on #667 | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/21-replay-640-651-677-on-691-20261021` | [#704](https://github.com/Naveax/Nexowire/pull/704) test(p0): exact #640/#651/#677 replay on #691 + #667 Native cancel fence | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/21-unchanged-qa640-651-677-on-725-20261022` | [#730](https://github.com/Naveax/Nexowire/pull/730) test(p0): unchanged #640/#651/#677/#704 replay on #725 Artifact cancellation… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/22-691-crosshub-dispatch-20261021` | [#708](https://github.com/Naveax/Nexowire/pull/708) test(p0): independent #691 predispatch CAS and two-Hub stale publish QA (#22) | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/22-807-unchanged-708-replay-20261023` | [#834](https://github.com/Naveax/Nexowire/pull/834) test(qa22): replay original #708 hostile checkpoint CAS on #807, fail closed… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/22-crosshub-expiry-receipts-20261021` | [#682](https://github.com/Naveax/Nexowire/pull/682) test(p0): cross-Hub CORE revoke, lease-expiry and signed publish receipt gat… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/22-crosshub-fencing-20261021` | [#641](https://github.com/Naveax/Nexowire/pull/641) test(p0): independent two-Hub CAS/fencing race acceptance (#588) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/22-crosshub-repair-publish-20261021` | [#653](https://github.com/Naveax/Nexowire/pull/653) test(p0): cross-Hub publish-once vs CORE re-pair and rollback QA (#22) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/24-delta-759-773-exact-20261022` | [#778](https://github.com/Naveax/Nexowire/pull/778) test(qa24): incremental #759-#773 exact CI/merge-base drift blockers | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/24-delta-774-779-source-20261022` | [#789](https://github.com/Naveax/Nexowire/pull/789) test(qa24): paginated open-set and exact CI delta #774–#779 | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/24-delta-781-790-source-20261022` | [#803](https://github.com/Naveax/Nexowire/pull/803) test(qa24): exact #781–#790 CI, paginated GET census and red owner collisions | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/24-delta-791-803-paged-source-20261022` | [#810](https://github.com/Naveax/Nexowire/pull/810) test(qa24): #791–#803 exact CI, two-pass 202+ REST and red-owner DAG | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/24-full-open-dag-104-sha-20261021` | [#772](https://github.com/Naveax/Nexowire/pull/772) test(qa24): 160-PR partitioned exact-SHA DAG and fail-closed merge review | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/24-integration-dag-provenance-20261021` | [#646](https://github.com/Naveax/Nexowire/pull/646) test(qa24): exact-SHA integration DAG, CI matrix and owner collision negativ… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/24-live-dag-77-merge-evidence-20261021` | [#698](https://github.com/Naveax/Nexowire/pull/698) test(qa24): 77-open-PR exact SHA DAG, negative stale CI and conditional merg… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/24-live-dag-drift-gates-20261021` | [#664](https://github.com/Naveax/Nexowire/pull/664) test(qa24): live 50-PR DAG refresh, stale SHA and CI no-false-green gates | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/24-open-census-811-git-owner-20261023` | [#838](https://github.com/Naveax/Nexowire/pull/838) test(qa24): 232-open two full REST passes, #811 Git original-negative collis… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/24-two-pass-open248-owner-qa-20261023` | [#852](https://github.com/Naveax/Nexowire/pull/852) test(qa24): 248-open two-pass exact refs, red Git/runbook CI and empty merge… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/25-crash-ack-root-readback-20261021` | [#716](https://github.com/Naveax/Nexowire/pull/716) test(p0): crash duplicate ACK, ROOT dispatch fence, signed readback UNKNOWN … | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/25-late-permit-posteffect-unknown-20261022` | [#749](https://github.com/Naveax/Nexowire/pull/749) test(p0): post-#731 cross-Hub late-permit revoke keeps mutation UNKNOWN (#25) | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/25-native-commit-linearization-20261022` | [#761](https://github.com/Naveax/Nexowire/pull/761) test(p0): two-Hub native commit/revoke linearization with lost effect readba… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/25-owner-revoke-mid-exec-20261021` | [#643](https://github.com/Naveax/Nexowire/pull/643) test(p0): adversarial CORE revoke/re-pair during elevated execution (#25) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/25-postlaunch-revoke-ack-20261021` | [#654](https://github.com/Naveax/Nexowire/pull/654) test(p0): CORE post-launch revoke, lost ACK and ROOT deadline acceptance (#2… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/25-signed-postcondition-root-boundary-20261021` | [#688](https://github.com/Naveax/Nexowire/pull/688) test(p0): independent Ed25519 witness/postcondition and ROOT deadline QA (#2… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/25-two-hub-cas-revoke-readback-20261022` | [#740](https://github.com/Naveax/Nexowire/pull/740) test(p0): two-Hub external CAS/Access revoke and readback UNKNOWN (#25) | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/28-813-undo-lost-ack-concurrent-recovery-20261023` | [#836](https://github.com/Naveax/Nexowire/pull/836) test(p1 #28): independent real-API UNDO UNKNOWN and concurrent-conflict reco… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/28-broker-crash-rollback-independent-qa-20261021` | [#644](https://github.com/Naveax/Nexowire/pull/644) test(s3): independent Broker crash/rollback, stale DPAPI and offline revoke … | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/28-import-dag-durable-journal-adversarial-20261021` | [#713](https://github.com/Naveax/Nexowire/pull/713) test(s3): #28 signed import DAG recovery, offline re-pair and persistent no-… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/28-rebase-714-unchanged-journal-qa-20261022` | [#745](https://github.com/Naveax/Nexowire/pull/745) test(s3): #28 unchanged signed recovery QA replay on #714 atomic-switch owner | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/28-recovery-narrow-20261021` | [#658](https://github.com/Naveax/Nexowire/pull/658) test(s3): #28 narrow Broker crash/rollback and offline re-pair recovery QA | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/28-signed-stage-crash-idempotent-recovery-20261021` | [#685](https://github.com/Naveax/Nexowire/pull/685) test(s3): #28 signed stage crash, offline re-pair and rollback no-replay QA | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/29-audit-rotation-crosshub-617` | [#662](https://github.com/Naveax/Nexowire/pull/662) test(p0/qa29): independent readback, cross-Hub ACK fencing and rotating audi… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/29-cas-native-cross-owner-negatives-20261022` | [#746](https://github.com/Naveax/Nexowire/pull/746) test(p0/qa29): cross-owner CAS nonce vs native Broker receipt NO-GO negatives | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/29-elevated-audit-provenance-617` | [#648](https://github.com/Naveax/Nexowire/pull/648) test(p0): independent elevated command audit provenance and UNKNOWN anti-rep… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/29-native-receipt-verifier-617` | [#699](https://github.com/Naveax/Nexowire/pull/699) test(p0/qa29): signed OS FILETIME and independent postcondition receipt veri… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/36-780-windows-restricted-preflight-20261023` | [#820](https://github.com/Naveax/Nexowire/pull/820) test(qa36 #780): fail-closed Windows restricted worker preflight and physica… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/37-adversarial-git-metadata-20261023` | [#814](https://github.com/Naveax/Nexowire/pull/814) test(qa37 #780): adversarial Git metadata/link/config fuzz against real work… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/38-reviewed-patch-negative-20261023` | *İsimden:* 38 reviewed patch negative | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `test/43-independent-final-checkpoint-qa-20261023` | [#816](https://github.com/Naveax/Nexowire/pull/816) test(p0): independent final publication/checkpoint adversarial QA (#43) | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/44-open-pr-dag-exact-ci-20261023` | [#831](https://github.com/Naveax/Nexowire/pull/831) test(qa44): independent paginated open-PR DAG and exact-head CI integration … | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/50-git-process-filter-red-20261023` | [#839](https://github.com/Naveax/Nexowire/pull/839) test(red-team #50): Git status filter.process external command escapes task … | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/50-p1-git-clean-filter-red-20261023` | [#821](https://github.com/Naveax/Nexowire/pull/821) test(red team #50): Git status clean-filter executes outside task PathPolicy… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/connection-journal-reconciliation-20261019` | [#580](https://github.com/Naveax/Nexowire/pull/580) test(connection): device-bound Journal v2 reconciliation and lost-ACK accept… | MERGED PR geçmişi | PR 2026-10-20 | **İNCELE / merge sonrası** |
| `test/integration-576-job-598-mcp-20261021` | [#608](https://github.com/Naveax/Nexowire/pull/608) test(integration): verify #576 Windows Job drain with #598 9.5 MiB MCP | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/integration-core618-qa619-20261021` | [#622](https://github.com/Naveax/Nexowire/pull/622) test(core): integrate #619 Hyper-V QA with real preapproved ROOT/CORE (#618) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/integration-core622-winjob576-20261021` | [#629](https://github.com/Naveax/Nexowire/pull/629) test(core): integrate updated Windows Job #576 with effective CORE and QA #6… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/linux-native-agent-live` | [#46](https://github.com/Naveax/Nexowire/pull/46) Add real Linux native-agent integration CI | MERGE olmadan kapanmış PR | PR 2026-09-30 | **İNCELE / commit karşılaştır** |
| `test/p0-hyperv-elevation-evidence-617-20261021` | [#618](https://github.com/Naveax/Nexowire/pull/618) test(p0): fail-closed Windows elevation and Hyper-V UNKNOWN evidence (#617) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/p05-native-relative-acl-20261021` | [#690](https://github.com/Naveax/Nexowire/pull/690) test(p0 #05): enforce grant-root-relative native handle chain and effective … | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/p05-transitive-import-handle-20261021` | [#707](https://github.com/Naveax/Nexowire/pull/707) test(p0 #05): require complete transitive updater DLL signer/hash/native han… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/p05-verified-handle-acl-20261021` | [#673](https://github.com/Naveax/Nexowire/pull/673) test(p0 #05): require verified native handle identity and protected ACL sour… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-07-oauth-http-auth-dos-20261020` | [#604](https://github.com/Naveax/Nexowire/pull/604) test(mcp/#598): OAuth verifier attribution and pre-auth 9.5 MiB DOS negatives | MERGE olmadan kapanmış PR | PR 2026-10-21 | **İNCELE / commit karşılaştır** |
| `test/parallel-14-core-quota-fencing-20261021` | [#625](https://github.com/Naveax/Nexowire/pull/625) test(scale-v2): scoped CORE artifact cancellation epoch and proof negatives | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-14-crosshub-revoke-readback-20261021` | [#687](https://github.com/Naveax/Nexowire/pull/687) fix(scale-v2): cross-Hub writer revoke readback and exactly-once disk release | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-14-predispatch-unknown-20261021` | [#718](https://github.com/Naveax/Nexowire/pull/718) test(scale-v2): quota cleanup for #691 predispatch and #682 late UNKNOWN | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `test/parallel-14-quota-receipt-provenance-20261021` | [#610](https://github.com/Naveax/Nexowire/pull/610) fix(scale-v2): require trusted receipt evidence for cancelled artifact quota | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-15-s5-38mib-lease-20261021` | [#628](https://github.com/Naveax/Nexowire/pull/628) test(scale-s5): bounded 4×9.5MiB loopback, tenant fairness and #596 lease au… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/parallel-15-s5-598-full-source-ci-20261021` | [#711](https://github.com/Naveax/Nexowire/pull/711) test(scale-s5): real #598 4x9.5MiB seeded CI parser and 64 tiny fairness | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-15-s5-598-seeded-parser-20261021` | [#674](https://github.com/Naveax/Nexowire/pull/674) test(scale-s5): fixed-seed real #598 parser gzip/fairness and bounded metrics | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-15-s5-cancel-ack-fairness-20261021` | [#689](https://github.com/Naveax/Nexowire/pull/689) test(scale-s5): deterministic cancellation receipt, parser-close barrier and… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-15-s5-gzip-full-quiet-receipt-20261021` | [#738](https://github.com/Naveax/Nexowire/pull/738) test(scale-s5): four 9.5MiB inflated gzip parsers vs quiet 64 and pending re… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/parallel-15-s5-http-stream-isolation-20261020` | [#606](https://github.com/Naveax/Nexowire/pull/606) test(scale-s5): bound 9.5MiB HTTP contention, small MCP fairness and #596 ch… | MERGED PR geçmişi | PR 2026-10-21 | **İNCELE / merge sonrası** |
| `test/parallel-15-s5-oct21-gzip-proof` | [#615](https://github.com/Naveax/Nexowire/pull/615) test(scale-s5): 21 Oct current-main gzip admission and SHA-bound local fairn… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/parallel-15-scale-load-cost-20261018` | [#564](https://github.com/Naveax/Nexowire/pull/564) test(scale-s5): concurrent ingress fairness and WSS/DO cost follow-up (#487) | MERGED PR geçmişi | PR 2026-10-18 | **İNCELE / merge sonrası** |
| `test/qa-19-709-path-identity-independent-20261022` | [#734](https://github.com/Naveax/Nexowire/pull/734) test(p0/qa19): independent hosted 100-cycle Job and original #709 protected-… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/qa-19-protected-import-witness-20261021` | [#717](https://github.com/Naveax/Nexowire/pull/717) test(p0/qa19): independently identify Windows importer ACL vs path-enumerati… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/qa-19-provider-cross-head-20261021` | [#679](https://github.com/Naveax/Nexowire/pull/679) test(p0/qa19): cross-head native provider truth and 100-cycle Windows Job re… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/qa-19-provider-truth-20261021` | [#652](https://github.com/Naveax/Nexowire/pull/652) test(p0/qa19): independently witness Windows provider truth, inherited ACL a… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/qa-19-winjob-hosted-repro-20261021` | [#638](https://github.com/Naveax/Nexowire/pull/638) test(p0/qa19): hosted Windows Job 100-cycle drain and PID owner anti-spoof | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/qa16-final-acceptance-refresh-20261018` | [#572](https://github.com/Naveax/Nexowire/pull/572) test(qa): refresh R01-R22 final acceptance and exact-head blocking findings | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/qa16-next2-837-821-814-826-829-20261023` | [#846](https://github.com/Naveax/Nexowire/pull/846) test(qa16): NEXT2 R01–R22 exact CI and Git filter/link/runbook blockers | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/qa16-next4-826-847-811-845-829-20261023` | *İsimden:* qa16 next4 826 847 811 845 829 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `test/qa16-pr677-702-exact-ci-20261021` | [#729](https://github.com/Naveax/Nexowire/pull/729) test(qa16): independent #677–#702 exact-head acceptance and CORE NO-GO | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/qa16-pr703-729-exact-ci-20261022` | [#744](https://github.com/Naveax/Nexowire/pull/744) test(qa16): #703–#729 exact HEAD CI, P0 RED vs hosted failures | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/qa16-pr730-745-docsonly-20261022` | [#758](https://github.com/Naveax/Nexowire/pull/758) docs(qa16): #730–#745 exact HEAD acceptance, historical CI and CORE NO-GO | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/qa16-pr747-758-exact-ci-20261022` | [#769](https://github.com/Naveax/Nexowire/pull/769) test(qa16): #747–#758 exact-head acceptance, CORE P0 red vs CI defects | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/qa16-pr759-773-exact-evidence-20261022` | [#779](https://github.com/Naveax/Nexowire/pull/779) test(qa16): #759–#773 exact-head CI, P0 CORE/Hyper-V and publisher NO-GO | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/qa16-pr774-780-p1-checklist-20261022` | [#790](https://github.com/Naveax/Nexowire/pull/790) test(qa16): #774–#779 exact CI and separate #780 P1 feature acceptance | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/qa16-pr779-790-ci-provenance-20261022` | [#802](https://github.com/Naveax/Nexowire/pull/802) test(qa16): exact #779/#790 CI failure provenance and separate #780 P1 matrix | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/qa16-pr791-803-exact-proof-20261022` | [#809](https://github.com/Naveax/Nexowire/pull/809) test(qa16): #791–#803 exact CI and reproduced CAS/UI/fsmonitor P0–P1 reds | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `test/qa16-pr806-811-physical-proof-20261023` | [#837](https://github.com/Naveax/Nexowire/pull/837) test(qa16): #806–#811 physical NO-GO and exact source/CI evidence | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `test/qa17-670-native-provider-import-epoch-20261021` | [#681](https://github.com/Naveax/Nexowire/pull/681) test(QA #17): #670 Windows provider UNAVAILABLE, signed import swap and stal… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/qa17-700-unavailable-filetime-acceptance-20261021` | [#705](https://github.com/Naveax/Nexowire/pull/705) test(QA #17): preserve #700 red ACL and independently reject forged provider… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/qa17-709-unchanged-provider-filetime-evidence-20261022` | *İsimden:* qa17 709 unchanged provider filetime evidence | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `test/qa17-753-exact-v1-reject-on-756-20261022` | *İsimden:* qa17 753 exact v1 reject on 756 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `test/qa17-763-unchanged-strict-json-replay-20261022` | *İsimden:* qa17 763 unchanged strict json replay | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `test/qa17-core-bootstrap-revoke-617-20261021` | [#636](https://github.com/Naveax/Nexowire/pull/636) test(QA #17): independent signed CORE bootstrap and revoke negatives (#617) | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/qa17-core-broker-adversarial-617-20261021` | [#635](https://github.com/Naveax/Nexowire/pull/635) test(QA #17): independent adversarial CORE/ROOT Broker source acceptance (#6… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/qa17-nwjob5-installed-handle-physical-contract-20261023` | [#850](https://github.com/Naveax/Nexowire/pull/850) test(qa17): WIN-HANDLE-01 signed NWJOB5 guardian physical negative contract | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/qa17-provider-unavailable-queued-revoke-617-20261021` | [#650](https://github.com/Naveax/Nexowire/pull/650) test(QA #17): fail-closed native provider outages and queued CORE revoke (#6… | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `test/qa19-830-byte-identical-on-829-20261023` | [#841](https://github.com/Naveax/Nexowire/pull/841) test(qa19): run byte-identical QA830 against #829 durable NWJOB5 source | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/qa19-nwjob5-durable-fast-exit-20261023` | [#830](https://github.com/Naveax/Nexowire/pull/830) test(qa19): independent durable Windows Job fast-exit journal regression | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `test/qa27-local-broker-external-core-matrix-20261021` | [#722](https://github.com/Naveax/Nexowire/pull/722) test(QA #27): independent local OS Broker trust and external CORE revoke neg… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `test/qa27-remote-admin-provenance-followup-20261021` | [#656](https://github.com/Naveax/Nexowire/pull/656) test(qa27): independent Remote Assistance UIAccess and signed Broker provena… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/qa27-uac-remote-approval-20261021` | [#645](https://github.com/Naveax/Nexowire/pull/645) test(QA #27): UAC Remote Assistance capability matrix and consent-negative s… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/qa27-windows-approval-native-witness-20261021` | [#684](https://github.com/Naveax/Nexowire/pull/684) test(qa27): independent Windows-assisted approval witness and owner-absent n… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `test/windows-process-stop-cim-targeted-20261027` | [#905](https://github.com/Naveax/Nexowire/pull/905) test(Windows): fix hosted process.stop CIM timeout without weakening native … | MERGE olmadan kapanmış PR | PR 2026-10-27 | **İNCELE / commit karşılaştır** |

### CORE / Broker / yetkilendirme (82)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `docs/03-task-process-token-network-780-20261022` | [#793](https://github.com/Naveax/Nexowire/pull/793) docs(p1 #780): Windows Job vs restricted token task acceptance; #786 Git-roo… | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `docs/03-task-sandbox-780-feasibility-20261022` | [#788](https://github.com/Naveax/Nexowire/pull/788) docs(p1 #780): Windows Job/ProcessManager task sandbox feature inventory and… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `docs/07-task-os-sandbox-provider-contract-20261024` | [#859](https://github.com/Naveax/Nexowire/pull/859) feat(#07): fail-closed OS task worker runtime port and kernel evidence contr… | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `feat/03-core-executor-gates-617` | [#633](https://github.com/Naveax/Nexowire/pull/633) security(p0): broad CORE/ROOT Broker trust contract and Windows CI trust fix… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `feat/03-hyperv-typed-gate-617` | [#620](https://github.com/Naveax/Nexowire/pull/620) security(p0): typed Hyper-V VM GUID admission with elevated dispatch disable… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/04-active-job-auth-fence-20261021` | [#719](https://github.com/Naveax/Nexowire/pull/719) test(p0): Access queued CORE/ROOT revoke and authenticated CAS readback (#61… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/04-core-delegation-617` | [#621](https://github.com/Naveax/Nexowire/pull/621) feat(p0): durable CORE owner delegation and broad signed Broker admission (#… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/04-core-effective-authority-20261021` | [#669](https://github.com/Naveax/Nexowire/pull/669) feat(p0): verify CORE/ROOT EFFECTIVE through signed native Broker and extern… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/04-core-ui-epoch-truth-20261022` | [#808](https://github.com/Naveax/Nexowire/pull/808) fix(p0): CORE UI owner epoch and native CAS proof fail-closed (#726 #617) | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `feat/04-diff-approval-authority-20261022` | [#787](https://github.com/Naveax/Nexowire/pull/787) test(p0): keep reviewed diff approval separate from effective CORE and nativ… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/04-final-dispatch-grant-20261022` | [#767](https://github.com/Naveax/Nexowire/pull/767) test(p0): require signed installed Broker and final CAS grant at CORE/ROOT l… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/04-final-identity-binding-20261022` | [#775](https://github.com/Naveax/Nexowire/pull/775) test(p0): bind signed final Access CAS grant to installed FileID and native … | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/04-late-permit-effective-20261022` | [#757](https://github.com/Naveax/Nexowire/pull/757) test(p0): deny late signed CORE/ROOT permit during revokeAndDrain (#731) | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/04-nonce-native-cas-readback-20261022` | [#741](https://github.com/Naveax/Nexowire/pull/741) test(p0): require nonce-bound protected Broker and CAS epoch for Access CORE… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/08-issuer-fixture-contract-20261022` | [#797](https://github.com/Naveax/Nexowire/pull/797) fix(p0): bind Artifact checkpoint to original durable transfer UUID and exte… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `feat/08-mutation-fence-20261021` | [#634](https://github.com/Naveax/Nexowire/pull/634) fix(p0): fenced Artifact writer receipts and live CORE grant revocation (#58… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/12-core-bootstrap-delegation-20261021` | [#632](https://github.com/Naveax/Nexowire/pull/632) test(s3): CORE Broker bootstrap DPAPI, task identity and revoke gates (#551 … | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/40-human-diff-review-authority-20261023` | [#833](https://github.com/Naveax/Nexowire/pull/833) feat(p1 #780 #40): source-only signed human diff consent scoped to #795 and … | AÇIK PR (Draft) | PR 2026-10-22 | **KORU / PR incele** |
| `feat/core-durable-native-approval-20261029` | [#969](https://github.com/Naveax/Nexowire/pull/969) feat(core): persist scoped native approval consumption and repair diagnostic… | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `feat/core-native-enrollment-verifier-20261029` | [#970](https://github.com/Naveax/Nexowire/pull/970) feat(core): add durable enrollment handoff and independent mTLS verifier | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `feat/core-native-session-readback-20261029` | [#960](https://github.com/Naveax/Nexowire/pull/960) feat(core): implement read-only Win32 session witness for native approval au… | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `feat/core-native-webauthn-approval-20261029` | [#964](https://github.com/Naveax/Nexowire/pull/964) feat(core): implement Windows WebAuthn verification component without granti… | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `feat/core-postgres-dispatch-server-20261029` | [#963](https://github.com/Naveax/Nexowire/pull/963) feat(core): implement durable PostgreSQL dispatch server with real restart CI | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `feat/core-signed-runtime-manifest-20261029` | [#966](https://github.com/Naveax/Nexowire/pull/966) feat(core): bind runtime payload integrity and rollback checks to signed man… | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `feat/parallel-10-broker-preflight-20261021` | [#665](https://github.com/Naveax/Nexowire/pull/665) test(p0): independent read-only signed CORE Broker preflight and unavailable… | MERGED PR geçmişi · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `feat/parallel-10-core-physical-evidence-20261021` | [#627](https://github.com/Naveax/Nexowire/pull/627) test(p0): fail-closed CORE physical readiness and signed Broker evidence (#6… | MERGED PR geçmişi | PR 2026-10-29 | **İNCELE / merge sonrası** |
| `feat/parallel-10-immutable-pid-filetime-cas-qa-20261021` | [#715](https://github.com/Naveax/Nexowire/pull/715) test(p0): independent Broker FILETIME and external CORE epoch fail-closed QA | AÇIK PR (Draft) | PR 2026-10-21 | **KORU / PR incele** |
| `feat/privilege-boundary-foundation` | [#50](https://github.com/Naveax/Nexowire/pull/50) Add first-party privileged execution boundary | MERGE olmadan kapanmış PR | PR 2026-09-30 | **İNCELE / commit karşılaştır** |
| `fix/01-bound-grant-monotonic-cas-20261021` | [#676](https://github.com/Naveax/Nexowire/pull/676) fix(p0): externally atomic owner grant CAS with revoke and migration reconci… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/01-broker-dispatch-clock-validation-20261027` | [#922](https://github.com/Naveax/Nexowire/pull/922) fix(p0): fail closed on invalid Broker dispatch clocks and TTL | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-broker-dispatch-expiry-after-readback-20261027` | [#918](https://github.com/Naveax/Nexowire/pull/918) fix(p0): expire external dispatch proofs after asynchronous HIGH readback | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-broker-dispatch-external-fence-20261021` | [#702](https://github.com/Naveax/Nexowire/pull/702) fix(p0): external CAS Broker dispatch owner-epoch fence and draining revoke | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-broker-dispatch-nonce-epoch-20261021` | [#712](https://github.com/Naveax/Nexowire/pull/712) fix(p0): nonce-bind Broker dispatch and fence stale owner epoch after WAL re… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/01-broker-dispatch-wire-boundary-20261027` | [#930](https://github.com/Naveax/Nexowire/pull/930) feat(p0): validate external Broker dispatch wire boundary | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-broker-release-owner-scoped-20261027` | [#910](https://github.com/Naveax/Nexowire/pull/910) fix(p0): bind Broker dispatch release to immutable owner/session claim | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-broker-reserve-lost-ack-contract-20261027` | [#921](https://github.com/Naveax/Nexowire/pull/921) fix(p0): fence uncertain Broker reservations and reject replay | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-broker-revoke-freshness-drain-20261027` | [#923](https://github.com/Naveax/Nexowire/pull/923) fix(p0): allow owner revoke after UNKNOWN with fresh drain proof | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-dispatch-monotonic-deadlines-20261027` | [#926](https://github.com/Naveax/Nexowire/pull/926) fix(p0): bound Broker dispatch receipts by monotonic elapsed time | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-grant-cas-response-challenge-20261027` | [#925](https://github.com/Naveax/Nexowire/pull/925) fix(p0): bind grant CAS responses to fresh HTTPS challenges | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/01-grant-cas-wire-boundary-20261027` | [#931](https://github.com/Naveax/Nexowire/pull/931) feat(p0): validate challenged grant CAS wire boundary | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `fix/01-immutable-dispatch-request-20261028` | [#947](https://github.com/Naveax/Nexowire/pull/947) fix(p0): deep-freeze validated Broker dispatch admission and preserve origin… | AÇIK PR (Draft) | PR 2026-10-28 | **KORU / güncel PR** |
| `fix/01-monotonic-remote-trust-20261020` | [#607](https://github.com/Naveax/Nexowire/pull/607) fix(p0): require rollback-external monotonic witness for Agent CAS gateway | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/01-runbook-native-admission-failclosed-20261023` | [#826](https://github.com/Naveax/Nexowire/pull/826) fix(p0): fail-close durable runbook UNKNOWN native dispatch without external… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/01-witness-delegation-20261021` | [#631](https://github.com/Naveax/Nexowire/pull/631) feat(p0): signed CORE/ROOT owner-session delegation epochs backed by witness… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/01-witness-owner-epoch-20261021` | [#614](https://github.com/Naveax/Nexowire/pull/614) feat(p0): external monotonic witness CAS contract with signed owner epoch mi… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/02-broker-server-effect-admission-20261027` | [#919](https://github.com/Naveax/Nexowire/pull/919) security(#02): gate every privileged Broker execute path behind external one… | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02-job-dup-handle-mic-guard-20261027` | [#914](https://github.com/Naveax/Nexowire/pull/914) security(#02): fail-close low-integrity Job guardians and test real Medium→H… | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02a-job-handle-post-attestation-seal-20261027` | [#929](https://github.com/Naveax/Nexowire/pull/929) security(#02A): fail-close Job root unless guardian seals equal-HIGH handle … | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02a-sedebug-unicode-token-readback-20261028` | [#952](https://github.com/Naveax/Nexowire/pull/952) fix(#02A): correct Unicode SeDebug lookup and read back token privileges | AÇIK PR (Draft) | PR 2026-10-28 | **KORU / güncel PR** |
| `fix/02b-broker-admission-challenge-bound-effects-20261027` | [#932](https://github.com/Naveax/Nexowire/pull/932) security(#02B): nonce-bound external CAS receipts and immutable effect input… | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02b-broker-health-true-token-evidence-20261028` | [#939](https://github.com/Naveax/Nexowire/pull/939) security(#02): report actual Windows token elevation in Broker health | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02b-effect-admission-monotonic-expiry-20261028` | [#938](https://github.com/Naveax/Nexowire/pull/938) security(#02B): expire Broker native effects by monotonic elapsed time | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02b-windows-broker-privileged-fixture-20261027` | [#937](https://github.com/Naveax/Nexowire/pull/937) test(#02B): make Windows Broker admission fixture exercise elevated machine … | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/03-829-strict-json-physical-seam-20261023` | [#851](https://github.com/Naveax/Nexowire/pull/851) fix(p0 #03): carry strict JSON Broker v1 denial onto durable NWJOB5 and docu… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/03-core-broker-cas-dispatch-gate-20261027` | [#913](https://github.com/Naveax/Nexowire/pull/913) fix(p0 #03): wire Windows Broker mutation callback through external CAS fenc… | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `fix/03-core-broker-effect-cas-dispatch-20261027` | [#915](https://github.com/Naveax/Nexowire/pull/915) fix(p0 #03): enforce external CAS begin+commit at legacy Windows Broker effe… | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `fix/03-core-session-generation-fence-20261027` | [#907](https://github.com/Naveax/Nexowire/pull/907) fix(p0 #03): bind CORE executor prerequisites to authenticated session and g… | AÇIK PR (Draft) | PR 2026-10-27 | **KORU / PR incele** |
| `fix/03-protected-broker-tree-and-pid-gate-20261021` | [#700](https://github.com/Naveax/Nexowire/pull/700) fix(p0): source gate full Broker import/updater ACL and exact Win32 PID iden… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/03-strict-json-v1-native-boundary-20261022` | [#763](https://github.com/Naveax/Nexowire/pull/763) fix(p0): strict Windows Broker JSON v1 typed schema, keep legacy ACL and dis… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/03-windows-broker-provider-attestation-20261021` | [#670](https://github.com/Naveax/Nexowire/pull/670) fix(p0): native Windows Broker/Job Authenticode ACL provider truth (#617) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/03-windows-core-dispatch-cas-seam-20261027` | [#916](https://github.com/Naveax/Nexowire/pull/916) fix(p0 #03): fail-close Windows mutation callbacks behind CORE external CAS … | AÇIK PR (Draft) | PR 2026-10-28 | **KORU / güncel PR** |
| `fix/04-core-console-enrollment-once-20261027` | [#911](https://github.com/Naveax/Nexowire/pull/911) fix(#04): reject replayed and stale physical CORE enrollment certificates | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/08-checkpoint-external-commit-20261022` | [#785](https://github.com/Naveax/Nexowire/pull/785) fix(p0): require external publication CAS before Artifact checkpoint persist… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/09-ai-screen-additional-gui-broker-20261020` | [#602](https://github.com/Naveax/Nexowire/pull/602) fix(p0): deny indirect Windows task DLL COM WMI GUI brokers (#402) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/12-atomic-switch-repair-20261021` | [#714](https://github.com/Naveax/Nexowire/pull/714) test(s3): signed CORE atomic rollback identity and stale DPAPI re-pair fence… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/12-import-dag-repair-bootstrap-20261021` | [#696](https://github.com/Naveax/Nexowire/pull/696) fix(s3): signed Windows import DAG and offline CORE re-pair fence (#672 chil… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/12-native-acl-dispatch-permit-source-20261022` | [#739](https://github.com/Naveax/Nexowire/pull/739) fix(s3): bind CORE native ACL v2 imports to signed owner epoch/nonce permit … | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/12-signed-bootstrap-owner-20261021` | [#672](https://github.com/Naveax/Nexowire/pull/672) fix(s3): signed protected CORE installer/import graph linked to owner Broker… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/12-signed-release-dag-permit-v2-20261022` | [#755](https://github.com/Naveax/Nexowire/pull/755) fix(s3): bind CORE permit v2 to signed import DAG, rollback and SYSTEM DPAPI… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/31-scoped-git-executor-20261022` | [#811](https://github.com/Naveax/Nexowire/pull/811) fix(p1 #780): fail-closed Git workspace root, metadata and fsmonitor executo… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/ai-screen-direct-bridge-broker-guard-20261014` | [#480](https://github.com/Naveax/Nexowire/pull/480) fix(ai-screen): unify direct desktop and worker GUI broker deny gates | AÇIK PR (Draft) | PR 2026-10-20 | **KORU / PR incele** |
| `fix/core-appcontainer-profile-environment-20261029` | [#967](https://github.com/Naveax/Nexowire/pull/967) fix(qa): isolate AppContainer fixture from parent elevation and environment | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `fix/core-indefinite-idle-readiness-20261029` | [#961](https://github.com/Naveax/Nexowire/pull/961) fix(core): preserve persistent approval across idle outages and retries | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `fix/core-native-consent-immutable-20261029` | [#962](https://github.com/Naveax/Nexowire/pull/962) fix(core): preserve original native consent scope and signing pin across awa… | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `fix/core-persistent-dispatch-fence-20261029` | [#956](https://github.com/Naveax/Nexowire/pull/956) fix(core): persist dispatch uncertainty and keep local STOP independent of r… | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `fix/core-website-enrollment-retry-20261026` | [#875](https://github.com/Naveax/Nexowire/pull/875) fix(core-web): surface device enrollment queue and retry without disabling C… | MERGE olmadan kapanmış PR | PR 2026-10-26 | **İNCELE / commit karşılaştır** |
| `fix/parallel-04-access-core-adminbridge-20261018` | [#574](https://github.com/Naveax/Nexowire/pull/574) fix(p0): session-bound ROOT and fail-closed Guardian truth (follow-up #548) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/parallel-06-connection-recovery-20261018` | [#547](https://github.com/Naveax/Nexowire/pull/547) fix(s1): P0/P1 Connection Core v2 reconnect fencing and mutation safety | MERGED PR geçmişi | PR 2026-10-18 | **İNCELE / merge sonrası** |
| `fix/scale-external-writer-fence-admission-20261026` | [#889](https://github.com/Naveax/Nexowire/pull/889) fix(scale): require independent writer-fence authority before any artifact e… | MERGE olmadan kapanmış PR | PR 2026-10-26 | **İNCELE / commit karşılaştır** |
| `integration/core-p0-owner-candidates-20261029` | [#958](https://github.com/Naveax/Nexowire/pull/958) integration(core): combine exact P0 owner candidates with preserved history … | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `integration/core-six-gates-candidate-20261029` | [#968](https://github.com/Naveax/Nexowire/pull/968) integration(core): combine six-gate source candidates without activating pro… | AÇIK PR (Draft) · **child base** | PR 2026-10-29 | **KORU / açık PR tabanı** |
| `release/core-enrollment-retry-prod-baseline-20261026` | *İsimden:* core enrollment retry prod baseline | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |

### Diğer (26)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `feat/credential-roles-v1` | *İsimden:* credential roles v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/dashboard-ui-20261007` | *İsimden:* dashboard ui | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/platform-secret-config-v1` | *İsimden:* platform secret config v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/revocable-credentials` | [#51](https://github.com/Naveax/Nexowire/pull/51) Add revocable hash-only runtime credentials | MERGE olmadan kapanmış PR | PR 2026-09-30 | **İNCELE / commit karşılaştır** |
| `feat/wsl-structured-v1` | *İsimden:* wsl structured v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feature/account-entitlement-control-v0` | *İsimden:* account entitlement control v0 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `fix/01-grant-transition-snapshot-20261027` | [#924](https://github.com/Naveax/Nexowire/pull/924) fix(p0): pin owner scope across grant transition awaits | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02-windows-job-owner-dacl-trust-20261027` | [#909](https://github.com/Naveax/Nexowire/pull/909) security(#02): fail closed on user-owned or individually writable Windows Jo… | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/02b-receipt-immutable-snapshot-aba-20261028` | [#950](https://github.com/Naveax/Nexowire/pull/950) security(#02B): freeze signed receipt bytes before RESERVED/COMMITTED verifi… | AÇIK PR (Draft) | PR 2026-10-28 | **KORU / güncel PR** |
| `fix/02b-receipt-post-verify-recheck-20261028` | [#940](https://github.com/Naveax/Nexowire/pull/940) security(#02B): revalidate signed effect receipts after asynchronous verific… | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `fix/03-durable-nwjob5-early-output-20261023` | [#829](https://github.com/Naveax/Nexowire/pull/829) fix(p0 #03): durable Windows NWJOB5 early stdout/stderr capture before resume | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/03-native-effective-acl-pid-dup-20261022` | [#756](https://github.com/Naveax/Nexowire/pull/756) test(p0): native effective Win32 ACL, PID FILETIME and DUP_HANDLE fixture wi… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/03-protected-tree-hosted-path-binding-20261021` | [#709](https://github.com/Naveax/Nexowire/pull/709) fix(p0): Windows hosted protected-tree path identity and ACL evidence bindin… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/04-claim-readiness-after-native-readback-20261028` | [#951](https://github.com/Naveax/Nexowire/pull/951) fix(#04): close native claim readiness and platform TOCTOU found by #949 | AÇIK PR (Draft) · **child base** | PR 2026-10-28 | **KORU / açık PR tabanı** |
| `fix/08-unresolved-publish-resume-20261022` | [#777](https://github.com/Naveax/Nexowire/pull/777) fix(p0): block resume of UNKNOWN Native publication until external commit (#… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/09-759-stop-missing-state-unknown-20261022` | [#773](https://github.com/Naveax/Nexowire/pull/773) fix(p0): no false private desktop physical STOP from missing state (#402) | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/09-private-emergency-preflight-fence-20261022` | [#736](https://github.com/Naveax/Nexowire/pull/736) fix(p0): fence local AI Screen emergency before status and helper launch (#4… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/09-private-picker-owner-witness-20261022` | [#750](https://github.com/Naveax/Nexowire/pull/750) fix(p0): fail-close private picker grants without protected Job owner (#402) | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/09-private-runtime-owner-failclosed-20261021` | [#728](https://github.com/Naveax/Nexowire/pull/728) fix(p0): fail-close AI Screen child launch and PID-only emergency stop (#402) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/634-cancel-before-staged-write-20261021` | *İsimden:* 634 cancel before staged write | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `fix/ai-screen-wrapper-escape-native-picker-20261018` | [#570](https://github.com/Naveax/Nexowire/pull/570) fix(p0): fail closed on indirect WSL/Terminal GUI wrappers and verify native… | MERGED PR geçmişi | PR 2026-10-18 | **İNCELE / merge sonrası** |
| `fix/parallel-05-scoped-path-usb-grants-20261018` | [#553](https://github.com/Naveax/Nexowire/pull/553) feat(p0): scoped filesystem permissions and USB volume-bound grants | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/parallel-11-progress-proof-acceptance-20261018` | [#575](https://github.com/Naveax/Nexowire/pull/575) feat(progress): independent scoped result proof and watchdog acceptance (fol… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `fix/windows-job-helper-trust-qa-20261018` | [#576](https://github.com/Naveax/Nexowire/pull/576) security(p0): independently kernel-attest Windows Job ownership and gate hel… | AÇIK PR (Draft) · **child base** | PR 2026-10-27 | **KORU / açık PR tabanı** |
| `main` | *İsimden:*  | MAIN · **child base** | — | **KORU** |
| `security/control-plane-service-secret-source` | *İsimden:* control plane service secret source | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |

### Görev / workspace / artefakt (17)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `feat/04-task-worktree-unknown-scope-20261022` | [#795](https://github.com/Naveax/Nexowire/pull/795) test(p0): bind Access diff approval to task worktree and durable UNKNOWN eff… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/32-reviewed-git-patch-20261023` | [#813](https://github.com/Naveax/Nexowire/pull/813) feat(p1 #780): isolated reviewed Git-compatible diff/apply/undo contract (#3… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `feat/33-bounded-task-loop-engine-20261023` | [#822](https://github.com/Naveax/Nexowire/pull/822) feat(p1 #33): bounded read-only coding task loop with UNKNOWN no-replay gates | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `feat/34-secure-task-checkpoint-20261023` | [#815](https://github.com/Naveax/Nexowire/pull/815) feat(p1): isolated encrypted task checkpoint and safe context compaction (#7… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `feat/45-task-evidence-projection-20261023` | [#825](https://github.com/Naveax/Nexowire/pull/825) feat(p1 #780): fail-closed immutable task evidence projection (#45) | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `feat/48-coding-task-review-ui-20261023` | [#828](https://github.com/Naveax/Nexowire/pull/828) feat(ui48): isolated source-only coding task diff review and hostile regress… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `feat/artifact-tracking` | *İsimden:* artifact tracking | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/durable-process-io` | *İsimden:* durable process io | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/parallel-08-large-artifact-588-20261020` | [#596](https://github.com/Naveax/Nexowire/pull/596) feat(p1): resumable large Artifact Bridge streams without 256MiB whole-file … | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/parallel-08-store-job-failclosed-20261021` | [#616](https://github.com/Naveax/Nexowire/pull/616) fix(p0): fail-closed cross-Hub Artifact jobs and trusted quota/checkpoint ad… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/workspace-checkpoint-v2` | *İsimden:* workspace checkpoint v2 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `fix/08-cancel-native-dispatch-race-20261021` | [#667](https://github.com/Naveax/Nexowire/pull/667) fix(p0): preserve UNKNOWN native mutations across Artifact transfer cancella… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/08-checkpoint-final-race-20261022` | [#807](https://github.com/Naveax/Nexowire/pull/807) fix(p0): require protected checkpoint epoch admission through durable save (… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/08-final-monotonic-20261022` | [#768](https://github.com/Naveax/Nexowire/pull/768) fix(p0): external monotonic publication commit before Artifact COMPLETED (#5… | AÇIK PR (Draft) · **child base** | PR 2026-10-23 | **KORU / açık PR tabanı** |
| `fix/08-forged-receipt-late-cancel-20261021` | [#725](https://github.com/Naveax/Nexowire/pull/725) fix(p0): retain forged ACK provenance and UNKNOWN across Artifact cancel/pub… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/08-predispatch-cancel-fence-20261021` | [#691](https://github.com/Naveax/Nexowire/pull/691) fix(p0): cancel reserved Native transfer intent before dispatch, retain UNKN… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/scale-complete-writer-stop-20261026` | [#887](https://github.com/Naveax/Nexowire/pull/887) fix(scale): retain COMPLETE artifact escrow until writer stop is verified | MERGE olmadan kapanmış PR | PR 2026-10-26 | **İNCELE / commit karşılaştır** |

### Hub / MCP / kimlik / kota (17)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `feat/07-oauth-epoch-refresh-service-adapter-20261022` | [#748](https://github.com/Naveax/Nexowire/pull/748) security(oauth/#07): opt-in epoch-atomic refresh through real MCP issuer | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/08-publish-receipt-20261022` | [#754](https://github.com/Naveax/Nexowire/pull/754) fix(p0): require independent authenticated final Native publication receipt … | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/first-party-relay-v1` | *İsimden:* first party relay v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/hub-tls-v1` | [#40](https://github.com/Naveax/Nexowire/pull/40) Add direct TLS and block plaintext remote hub exposure | MERGE olmadan kapanmış PR | PR 2026-09-30 | **İNCELE / commit karşılaştır** |
| `feat/mcp-output-contract-v1` | *İsimden:* mcp output contract v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/mcp-surface-v1` | *İsimden:* mcp surface v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/parallel-14-quota-subscription-20261018` | [#554](https://github.com/Naveax/Nexowire/pull/554) feat(scale-v2): dormant quota and subscription entitlements (S2/S4) | MERGED PR geçmişi | PR 2026-10-18 | **İNCELE / merge sonrası** |
| `feat/solkaun-unmetered-hosted-tool-credits-20261030` | [#973](https://github.com/Naveax/Nexowire/pull/973) feat(quota): unmeter solkaun's verified GitHub account for hosted MCP tools | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `feat/token-rotation-auth` | [#24](https://github.com/Naveax/Nexowire/pull/24) Add rotating constant-time bearer authentication | MERGE olmadan kapanmış PR | PR 2026-09-29 | **İNCELE / commit karşılaştır** |
| `feature/mcp-remote-auth-metering` | *İsimden:* mcp remote auth metering | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `fix/12-import-ancestor-inventory-exact-20261022` | [#765](https://github.com/Naveax/Nexowire/pull/765) fix(s3): exact signed importer ACL closure and prior SYSTEM DPAPI revoke epo… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `fix/mcp-http-body-cap-588-20261020` | [#598](https://github.com/Naveax/Nexowire/pull/598) fix(mcp): bound incoming JSON and outgoing responses at 9.5 MiB (#588) | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/parallel-07-codex-oauth-compat-20261018` | [#545](https://github.com/Naveax/Nexowire/pull/545) fix(p0): Codex CLI OAuth loopback compatibility and MCP auth failure classif… | MERGED PR geçmişi | PR 2026-10-18 | **İNCELE / merge sonrası** |
| `integration/598-compressed-parser-admission-20261020` | [#600](https://github.com/Naveax/Nexowire/pull/600) fix(mcp): guard compressed JSON admission against 9.5MiB inflate bypass (#59… | MERGE olmadan kapanmış PR | PR 2026-10-21 | **İNCELE / commit karşılaştır** |
| `security/07-oauth-atomic-access-verifier-20261022` | [#760](https://github.com/Naveax/Nexowire/pull/760) security(oauth/#07): require epoch-bound access verification with atomic ref… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `security/07-oauth-epoched-owner-writer-principal-20261022` | [#792](https://github.com/Naveax/Nexowire/pull/792) security(oauth/#07): expose strict owner epoch principal for WSS/worker hand… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `security/07-oauth-issuer-fence-browser-revoke-20261021` | [#721](https://github.com/Naveax/Nexowire/pull/721) security(oauth/#07): monotonic issuer key fence, browser cancellation and fi… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |

### Kurulum / release / updater (11)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `chore/continuation-sync-20261001-6` | [#110](https://github.com/Naveax/Nexowire/pull/110) Sync continuation after release and cross-platform hardening | MERGE olmadan kapanmış PR | PR 2026-10-01 | **İNCELE / commit karşılaştır** |
| `docs/12-self-host-worker-install-acceptance-20261022` | [#804](https://github.com/Naveax/Nexowire/pull/804) docs(s3): exact self-host worker signed bootstrap, signer and revoke accepta… | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `docs/12-worker-installer-provider-contract-20261023` | [#842](https://github.com/Naveax/Nexowire/pull/842) docs(s3): physical self-host worker installer provider contract and #41 hand… | AÇIK PR (Draft) | PR 2026-10-23 | **KORU / PR incele** |
| `feat/npm-package-smoke-v1` | *İsimden:* npm package smoke v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/parallel-14-trusted-cleanup-admission-20261021` | [#668](https://github.com/Naveax/Nexowire/pull/668) test(scale-v2): authoritative writer-fence and disk-release quota admission | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `feat/release-tag-policy-v1` | *İsimden:* release tag policy v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/skill-v2-migration-pack-v2` | [#91](https://github.com/Naveax/Nexowire/pull/91) Expand manifest v2 migration to verification and incident skills | MERGE olmadan kapanmış PR | PR 2026-10-01 | **İNCELE / commit karşılaştır** |
| `feat/windows-protected-secret-sources-v1` | [#71](https://github.com/Naveax/Nexowire/pull/71) Add Windows DPAPI protected bootstrap secret sources | MERGE olmadan kapanmış PR | PR 2026-10-01 | **İNCELE / commit karşılaştır** |
| `fix/09-complete-writer-stop-20261024` | [#860](https://github.com/Naveax/Nexowire/pull/860) fix(scale #09): require independent writer-stop before COMPLETE disk escrow … | MERGE olmadan kapanmış PR | PR 2026-10-26 | **İNCELE / commit karşılaştır** |
| `fix/bootstrap-restart-updated-hub-env-v2` | [#158](https://github.com/Naveax/Nexowire/pull/158) Restart running Hub when persisted launcher config changes | MERGE olmadan kapanmış PR | PR 2026-10-03 | **İNCELE / commit karşılaştır** |
| `fix/first-pc-onboarding-guide-20261029` | [#971](https://github.com/Naveax/Nexowire/pull/971) fix(onboarding): fresh Windows install, Unicode shortcut and ChatGPT OAuth g… | AÇIK PR (Draft) | PR 2026-10-30 | **KORU / güncel PR** |

### Agent / bağlantı / WAL (11)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `docs/01-agent-loop-journal-contract-20261022` | [#783](https://github.com/Naveax/Nexowire/pull/783) docs(p1): Agent Journal loop checkpoint identity + read-only reconciliation … | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `docs/12-self-host-worker-deployment-identity-20261022` | [#798](https://github.com/Naveax/Nexowire/pull/798) docs(s3): self-host coding worker separate identity and restricted recovery … | AÇIK PR (Draft) · **child base** | PR 2026-10-22 | **KORU / açık PR tabanı** |
| `feat/agent-endpoint-failover-v1` | *İsimden:* agent endpoint failover v1 | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |
| `feat/native-agent-lifecycle-v2` | [#93](https://github.com/Naveax/Nexowire/pull/93) Add first-party native-agent install lifecycle | MERGE olmadan kapanmış PR | PR 2026-10-01 | **İNCELE / commit karşılaştır** |
| `feat/parallel-12-agent-lifecycle-onboarding-20261018` | [#551](https://github.com/Naveax/Nexowire/pull/551) feat(s3): isolated Agent lifecycle trust/rollback and secure one-click pairi… | AÇIK PR (Draft) · **child base** | PR 2026-10-26 | **KORU / açık PR tabanı** |
| `fix/01-unknown-retention-847-equivalent-20261024` | [#857](https://github.com/Naveax/Nexowire/pull/857) fix(trust): retain UNKNOWN journal across TTL and validate direct graph alia… | AÇIK PR (Draft) | PR 2026-10-26 | **KORU / PR incele** |
| `fix/06-transfer-grant-epoch-followup-20261021` | [#613](https://github.com/Naveax/Nexowire/pull/613) fix(connection): enforce current owner grants and epoch provenance on durabl… | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/13-owner-wss-receipt-replay-20261021` | [#671](https://github.com/Naveax/Nexowire/pull/671) fix(s2): fence signed WSS enrollment receipt replay across reconnects | AÇIK PR (Draft) · **child base** | PR 2026-10-21 | **KORU / açık PR tabanı** |
| `fix/agent-wal-recycle-boundary-20261029` | [#957](https://github.com/Naveax/Nexowire/pull/957) fix(agent): validate recycled WAL without clearing replay history | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `fix/agent-win-task-power-conditions-20261030` | [#972](https://github.com/Naveax/Nexowire/pull/972) fix(agent): allow Windows interactive native Agent on battery and UPS | AÇIK PR (Draft) | PR 2026-10-29 | **KORU / güncel PR** |
| `fix/p0-agent-journal-antirollback-20261019` | [#582](https://github.com/Naveax/Nexowire/pull/582) fix(p0): bind Agent mutations to independent monotonic anti-rollback reserva… | AÇIK PR (Draft) · **child base** | PR 2026-10-20 | **KORU / açık PR tabanı** |

### Docs / operasyon (2)

| Branch | PR / amaç | Durum | Son görülen güncelleme | Öneri |
| --- | --- | --- | --- | --- |
| `docs/sync-v103-final-state-20261007` | [#232](https://github.com/Naveax/Nexowire/pull/232) docs: sync v1.0.3 final acceptance state | MERGED PR geçmişi | PR 2026-10-07 | **İNCELE / merge sonrası** |
| `ops/plus-pro-billing-state-sync` | *İsimden:* plus pro billing state sync | EŞLEŞEN PR YOK | commit tarihi doğrulanmadı | **İNCELE / yetim veya eski** |

## 8. Temizlik işlemi öncesi kontrol listesi

1. İlgili **HEAD SHA / PR base / açık child** zincirini yeniden oku. Son 48 saatte branch'e commit geldi mi doğrula.
2. `git log main..branch --oneline`, `git diff main...branch --stat` ve stack varsa `git range-diff` ile benzersiz kodu ayır.
3. Aynı işin başka PR'da olup olmadığını **diff + test** ile doğrula; aynı başlık yetmez.
4. Branch'in tag, release, CI, deploy, worktree, dış referans veya kullanıcı bağımlılığı olup olmadığını doğrula.
5. Ancak açık onay ve bağımlılık temizliğinden sonra kontrollü branch silmeyi ayrı iş olarak yap. Bu dosya tek başına silme talimatı değildir.

**Güncelleme politikası:** Her büyük branch temizliğinden sonra bu dosyayı mevcut main SHA ve güncel GitHub durumu ile yenile. README'ye ayrıca bağlantı eklenebilir; bu ilk katalogda uygulama veya CI kaynak kodu değiştirilmedi.
