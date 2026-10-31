> Yardımcı 4 / 31 Ekim 2026 / belge ve sentetik test kapsamı.
> Kaynak tabanı: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main).
> Dal: `docs/delegated-r-rel-20261031`. AGENTS.md bulunmadı.
> Kaynak bağlantıları aşağıdaki göreli yollar için bu exact SHA üzerinden okunmalıdır:
> https://github.com/Naveax/Nexowire/tree/a19a228dc6f19fd484cf935e941a00ea625233f8
> Bu çalışma cihaz kabulü, güvenlik onayı veya üretim PASS değildir.

# REL-02 — Test ve CI kabul haritası

## Yerel komut semantiği

| package.json komutu | Gerçek içerik | Bu görevde durum |
|---|---|---|
| `npm run typecheck` | tsc -p tsconfig.json --noEmit | Yerel sonuç FINAL_HANDOFF içinde |
| `npm run build` | tsc -p tsconfig.json | Yerel sonuç FINAL_HANDOFF içinde |
| `npm run continuation:check` | scripts/check-continuation-state.ts | Kanonik dosya tutarlılığı; cihaz kabulü değil |
| `npm test` | node --test --import tsx test/**/*.test.ts | Tam küme ÇALIŞTIRILMADI; Agent/Hub/port başlatabilen testler var |
| `npm run check` | typecheck + continuation + ai-screen:launch-audit + npm test | Tam zincir ÇALIŞTIRILMADI; sadece sentetik seçili test |

`tsconfig.json` src ve test/**/*.ts ile yalnız `scripts/run-environment-doctor.ts`'yi kök olarak kapsar. Yeni redaction betiği test tarafından import edildiği için typecheck/build kapsamına girer. Bu tüm scripts klasörünün otomatik typecheck edildiği anlamına gelmez. `npm ci --ignore-scripts --no-audit --no-fund` izole clone'a bağımlılık kurar; ürün çalıştırmaz.

## .github/workflows/ci.yml — main SHA haritası

| Job | Ortam / test adları | Kanıtın sınırı |
|---|---|---|
| test (22), test (24) | Ubuntu; npm ci, check, build | Linux kaynak testleri; skip varsa fiziksel PASS değil |
| browser-live | Windows Node24; WAL recycle/integrity/restart/startup diagnostic; update-startup/launcher; CORE console; native Job/process; singleton; DPAPI; Windows controls/environment; browser/private desktop/durable-process; qa-* negatives | Hosted runner; kullanıcının iki cihazı veya kalıcı CORE enrollment kabulü değil |
| linux-native-live | linux-native-agent-live, relay-native-agent-live, opt-in env=1 | CI'da gerçek yerel Agent/relay; üretim endpoint/kapasite kanıtı değil |
| wsl2-live | Windows, gerçek Ubuntu24.04 WSL2, wsl-live | WSL runner kabulü; kullanıcı distro/USB/GPU kabulü değil |
| security-operational-live | Ubuntu security-operational-live; HTTPS OIDC scopes/revocation | İlgili negatif/operational coverage; bağımsız tam güvenlik onayı değil |
| macos-agent-lifecycle-live | LaunchAgent lifecycle, native-agent, platform-secret-store/Keychain | macOS runner; Windows veya kullanıcının macOS'u değil |

Kaynak test eşlemeleri: WAL → `agent-operation-wal-integrity.test.ts`, `qa-journal-wal-recycle-p11.test.ts`, `agent-journal-restart-regression.test.ts`; sonuç ayrımı → `agent-provider-task-outcome.test.ts`, `qa-shell-outcome-negative.test.ts`, `mcp-agent-outcome-reconciliation.test.ts`; Doctor → `environment-doctor.test.ts`; redaction → `test/delegated/redact-sample-log.test.ts` (bu PR ekler).

## Mevcut kanıt

Main exact `a19a228dc6f19fd484cf935e941a00ea625233f8`: [CI 41078541065](https://github.com/Naveax/Nexowire/actions/runs/41078541065) completed/success, API'den doğrulandı. Aynı SHA [Release Readiness 41082039175](https://github.com/Naveax/Nexowire/actions/runs/41082039175) completed/success. Bunlar bu PR'ın exact HEAD sonucuna aktarılamaz. Yeni PR CI ID/SHA/state FINAL_HANDOFF/PR açıklamasına koordinatör tarafından eklenebilir. Workflow dispatch/rerun yapılmadı; aktif aynı SHA/run yeniden başlatılmaz.

Başarı kaydı şablonu: ID | source issue | branch | exact SHA | command | OS/Node | timestamp+timezone | expected | observed | exit/result | synthetic/local/device | CI ID | blocker. Not-run ve skipped ayrı yazılır; geçmiş CI yeni SHA için PASS değildir.
