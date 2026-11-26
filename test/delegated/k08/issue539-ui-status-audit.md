# #539 R18 — UI success/readiness wording audit (T-380)

Base observed: `Naveax/Nexowire main` `4e7db16f4233048a956664bef6b607781eb63fb7`.
Read-only source search used case-insensitive success, completed, ready,
`başar`, `tamam` and `hazır` tokens in `web/*.js` / `web/*.html`.

| Source | Potential confusion | Source-backed counterevidence / remaining boundary |
| --- | --- | --- |
| `web/app.js` | “Broker hazır bildirimi” could look like ON/OFF success | Source explicitly says readiness is not proof the ON/OFF command applied, and shows distinct ON/OFF-not-verified text |
| `web/connect.js` | Green “Hazır” badge could look like connected device | Neighboring copy says the device will be added **when BAĞLA is pressed**; readiness is setup, not completed enrollment |
| `web/admin.js` | Usage success-rate indicator could be presented without a counter | `successRate === null` produces “Başarı oranı yok”; no fake percentage from null in inspected path |

No unambiguous unsupported “completed action” assertion was established from
these static excerpts. This is **source-only** language QA, not proof that
frontend asynchronous responses are ordered correctly or that an Agent task
finished. Browser/keyboard/actual OAuth and Windows operation: **NOT_RUN**.

The relevant UI sources are managed by K01–K04 and already overlap upstream
owner [#1068](https://github.com/Naveax/Nexowire/pull/1068). This K08 audit
does not edit those files. If a live screenshot contradicts these source
messages, send an exact UI state and device evidence to that owner, then rerun
the original [#539](https://github.com/Naveax/Nexowire/issues/539) acceptance.

Reproduce without UI or network:

```bash
node test/delegated/k08/issue539-ui-status-audit.test.mjs
```
