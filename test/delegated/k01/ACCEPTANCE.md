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
| Discovery metadata timeout / request abort | No guessed MCP address; distinguish timeout from stopped request | T-138/T-144 negative fixtures |
| Pairing network error / malformed success payload | No callback navigation; retry state remains explicit | T-138 negative fixtures |
| Second click during failed in-flight retries | No extra POST, focus only once per failed attempt | T-141 focus/dedup |
| OAuth cancellation without a local pairing callback | Installation mode; never displays connected | T-142 narrow cancellation-query fixture |
| Long untrusted device name | Rendered only as text, without HTML interpolation | T-143 source/VM fixture |

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

T-142 remains **partial**: the `?error=access_denied` offline fixture does not
model a complete provider OAuth callback or an authorized return path. Any
change to actual OAuth/session/redirect semantics requires the security/auth
owner. T-143 is a DOM/source assertion only, not proof that long strings fit a
375px screen; visual overflow and shared CSS remain K02/browser follow-ups.
T-144 distinguishes a request's `TimeoutError` from its `AbortError`, but an
`AbortError` alone does not establish deliberate user cancellation.

Proof needed: viewport dimensions, browser/OS version, URL without callback
secrets, screenshot IDs, keyboard actions, observed focus target, expected vs.
actual, and exact code-branch SHA. Redact callback state, pairing tokens, and
other secrets before storing evidence. Any CSS defect belongs to K02.
