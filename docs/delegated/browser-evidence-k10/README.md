# Browser evidence ledger (T-134)

This is a review template for **evidence**, not an instruction to enable access
to a real device, account, billing service or native agent. It separates tests
which read static source from observations taken in an actual browser.

Copy [template.json](template.json) outside the repository and fill in one row
per scenario. Do not commit browser cookies, tokens, account identifiers,
private screen contents, filesystem secrets, or unredacted user screenshots.

## Required provenance and result states

1. Pin the **exact 40-character commit SHA**, OS, browser name/version and
   artifact timestamp. A branch name or a CI run from an earlier SHA is not proof.
2. `sourceChecks` can be `PASS` when the local Node tests pass; record the exact
   command, counts, environment and run link (if CI exists).
3. `browserScreenshots` is `NOT_RUN` until real screenshots from a rendering
   browser exist. A generated viewport list, DOM fixture or synthetic PNG
   buffer is not such evidence.
4. A screenshot proves a **single captured state at one viewport**. List the
   URL/origin class, device-scale factor, viewport, screenshot artifact with
   checksum, visible state and whether HTTP(S) was disabled. No invisible
   state is inferred from pixels.
5. Keyboard focus and overflow require *separate* results and observations.
   A screenshot does not prove tab order or focus ring visibility.
6. A static `file://` capture is marked `PARTIAL`, even if all PNG dimensions
   and horizontal overflow checks pass, because authenticated API states are
   not exercised. There is no automatic promotion to `PASS`.
7. Missing CI job, browser binary, evidence file, hash, or screenshot inspection
   means `NOT_RUN` or `BLOCKED`, never a fabricated PASS. Physical Windows,
   two-device, live Agent/Hub/Broker and authorization acceptance are always
   separate from these web checks.

## Scenario matrix

For each `dashboard`, `connect`, and `admin` page capture all three widths when
a browser is available. Loading/empty/error/success fixture cases need distinct
API-controlled acceptance; do not infer them from a single static screenshot.

| Width / height | Source fixture | Browser screenshot | Overflow | Keyboard |
| --- | --- | --- | --- | --- |
| 375 × 812 | defined | NOT_RUN | NOT_RUN | NOT_RUN |
| 768 × 1024 | defined | NOT_RUN | NOT_RUN | NOT_RUN |
| 1440 × 900 | defined | NOT_RUN | NOT_RUN | NOT_RUN |

**Source commands:**

```sh
node test/delegated/k10/offline-web-smoke.test.mjs
node scripts/delegated/k10/offline-web-smoke.mjs --json
```

**Optional static screenshot capture (Playwright + Chromium already installed):**

```sh
node scripts/delegated/k10/browser-visual-smoke.mjs --out /tmp/nexowire-visual-smoke
```

The optional capture blocks HTTP(S). Its result is `PARTIAL` at best, not a
login, keyboard, state-mutation or device acceptance. Keep screenshots outside
the repository and reference sanitized artifact hashes/paths in the ledger.

The optional PNG validator rejects incomplete/chunk-CRC-corrupt or truncated
RGB/RGBA 8-bit screenshot files, mismatched viewport dimensions and invalid
compressed pixels. Test-generated PNG buffers are **only validator fixtures**,
never evidence that a browser rendered Nexowire.

## Reviewer decision

- `ACCEPT_STATIC_ONLY`: exact source checks passed, browser/physical remain
  open; safe to review a QA-only PR, not to claim UI acceptance.
- `NEEDS_BROWSER`: no real browser artifacts or visual results.
- `REJECT_EVIDENCE`: stale SHA, invalid/inconsistent artifact, missing identity
  or synthetic evidence presented as browser proof.
- `REVIEW_VISUAL`: real screenshots and independent visual observations exist;
  still does **not** authorize deployment or device actions.
