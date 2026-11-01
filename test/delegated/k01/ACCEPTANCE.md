# K01 connect screen — evidence matrix (source-only)

Baseline: `Naveax/Nexowire` `main` `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`.

This branch changes only the hosted connect page's presentation and deterministic
offline regression tests. It does **not** change authentication, permission,
pairing request bodies, callback validation, credentials, or the native Agent.

## State mapping and automated evidence

| State | Visible user outcome | Source-only evidence |
| --- | --- | --- |
| Plain `/connect.html` | OS installation + MCP address; approval hidden | T-001 install state |
| Windows → macOS via keyboard | Exactly one selected OS tab; installer command hidden | T-001 tab arrow key |
| Genuine loopback callback / account pending | Account checking; BAĞLA disabled | T-001 pending dashboard |
| Dashboard `401` | Navigates to GitHub login, no pairing POST | T-001 unauthorized |
| Dashboard `503` | Focused error; BAĞLA disabled; reload guidance | T-002 terminal error |
| Dashboard success | BAĞLA enabled; ready message | T-001 ready |
| Pairing POST pending | BAĞLANIYOR; disabled; second click ignored | T-003 duplicate-click |
| Pairing POST `503` | Error and focused TEKRAR DENE | T-002 retry |
| Retry success | Error cleared; only the strict loopback callback receives result | T-002 retry success |
| Device quota `403` | Limit message; retry disabled | T-002 nonretryable |
| External/incorrect callback | Install mode; no dashboard request | T-001 invalid callback |

Reproduce offline: `node --test --import tsx test/delegated/k01/connect-state.test.ts`

## T-005/T-006 pending real-browser acceptance

**NOT_RUN** — no actual screenshot, real Tab sequence, screen-reader output,
viewport measurement, Windows install, logged-in device, or two-machine pairing
is claimed by these DOM stubs and static CSS assertions.

Before claiming acceptance, capture a screenshot and actual keyboard/viewport
observations at 375px, 768px and desktop for each of:

1. Install-only page, each OS tab, metadata available and metadata unavailable.
2. Genuine pairing page in pending/ready/error states, with a disposable
   isolated test server and fixture account (never production credentials).
3. Failed pairing with keyboard focus and announced error; retry recovery;
   quota `403` without misleading retry.
4. Long device names, long localized errors, Zoom 200%, reduced motion and
   high-contrast focus styling; compare against `web/styles.css` owner K02.

Proof needed: viewport dimensions, browser/OS version, URL without callback
secrets, screenshot IDs, keyboard actions, observed focus target, expected vs.
actual, and exact code-branch SHA. Redact callback state, pairing tokens, and
other secrets before storing evidence. Any CSS defect belongs to K02.
