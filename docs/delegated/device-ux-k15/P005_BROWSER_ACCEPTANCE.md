# P005 device-card browser acceptance handoff — #539/R11, #812, #485

Date: 2026-11-08 (Europe/Istanbul). This is K15's independent QA handoff to
K10/browser owner and K03/UI owner. It does not claim to have run a browser.

## Exact provenance and what it proves

- Main `b5a3f8840517d65ecbd6a018699c4c8bdde09987`: `web/app.js`
  still renders duplicated generic per-device action labels and still
  allows an older dashboard response to replace newer 401 state.
- UI owner [#1068](https://github.com/Naveax/Nexowire/pull/1068)
  `94d38799e9e4b50fe84f7924e6fc84f90aeba090` is **open Draft**, not
  main. K15 VM cases run against it read-only; it is not a deployed UI.
- K15 [#1110](https://github.com/Naveax/Nexowire/pull/1110)
  exact previous HEAD `feb12ddc6351013b6f784bf2f629934999b85a23`:
  automatic CI [42411906346](https://github.com/Naveax/Nexowire/actions/runs/42411906346)
  completed with 7 successful jobs. Its step list **does not execute**
  K15's nested `.mjs` tests; CI success is not a hosted K15 test PASS.
- K10 [#1116](https://github.com/Naveax/Nexowire/pull/1116)
  `0f3916ecd3d3ff0db5d7a1743b007e52a0cd16aa`:
  automatic CI [42411883766](https://github.com/Naveax/Nexowire/actions/runs/42411883766)
  completed successfully, but its K10 three-state screenshot acquisition
  is **NOT_RUN**. Existing `browser-live` executes a different source
  suite, not K10's real screenshots. K10 reports local Chromium
  `socket() EPERM` and does not claim true browser capture.

## What a real browser/operator should demonstrate

| Observable screen/action | Negative case to capture | Evidence needed |
| --- | --- | --- |
| Two same-named PCs (`Ortak PC`), one action on second device | Reorder list and repeat; no action should target first ID | Actual per-device focus/accessibility names and request body exact `deviceId` in a controlled account |
| Same-named 100-character Unicode PCs | Name labels may disambiguate by ordinal but change upon reorder | Keyboard + accessibility tree on both list orders, explicit mapping to stable ID; note ordinal flip |
| One online, one offline, one missing/UNKNOWN heartbeat | Offline/unknown must not claim active Broker or grant | Screenshots of status text and disabled APPLY; `UNKNOWN` currently displays as offline (owner wording review) |
| CORE/ROOT preference reported active, but native local consent false/stale | Card must not claim verified physical control | Visible CORE/ROOT pending text vs separately collected signed local grant/observed input proof; fixture alone is insufficient |
| First setup, zero devices; then two same-named devices and AUTO preference | No implicit paired/success target from AUTO | UI zero-device state + selected device ID proof; only an authenticated live pairing can pass setup acceptance |
| Dashboard request A slow; newer request B returns 401; A later returns 200 | Old private device count/cards must not reappear | Browser network sequence and DOM state after both responses; check login remains visible |
| Dashboard 503 or pending after successful loaded list | Old counts/cards must not be mistaken for fresh | Visible loading/error semantic status, `aria-busy`, focus and 375px/768px/desktop screenshot |

Use K10's separate, real three-state pairing screenshot route for `loading`,
`error`, and `success` only after a browser run actually produced three
non-identical, valid PNG captures with origin/source SHA and viewport
evidence. CRC/SHA-256-valid synthetic PNG files cannot prove live pairing.

## Boundaries

K15 VM tests run UI rendering with a fake DOM and inspect request arguments;
they do **not** test browser focus order, assistive technology, screenshot
wrapping, CORS/cookies, actual MCP admission, local input rights, Windows
Agent/Broker or two-PC behavior. The browser runner, real screenshots,
Windows hardware and source merge are **NOT_RUN** here. K03 owns UI changes;
K10 owns browser artifacts; K13 owns CI test discovery.
