# Device identity and status evidence — #539/R11, #812, #485

Date: 2026-11-07 (Europe/Istanbul). K15's allowed work is **test and
documentation only**; no authentication, routing, device permission or
`web/app.js` changes are included.

## Exact sources checked

| Source | SHA | State |
| --- | --- | --- |
| `Naveax/Nexowire` `main` | `4e7db16f4233048a956664bef6b607781eb63fb7` | Published source baseline; still uses generic per-card accessible names and leaves old counts visible during a new pending/error request |
| Owner UI integration [#1068](https://github.com/Naveax/Nexowire/pull/1068) | `94d38799e9e4b50fe84f7924e6fc84f90aeba090` | Open Draft; inspected in a detached read-only worktree, **not in main** |
| Previous K15 [#1026](https://github.com/Naveax/Nexowire/pull/1026) | `84a40813627ad7f4a7ef4bea06e6a1677cbb1706` | Closed without direct merge; its old evidence is historical, not an installed release |

No preexisting `test/delegated/k15/` or
`docs/delegated/device-ux-k15/` paths were present on the checked main
tree. This work creates a new issue-scoped regression, reusing the tested
fake-DOM approach but not reopening the closed source PR.

## Real behavior contract and evidence

The self-contained `test/delegated/k15/issue-539-device-ux.test.mjs`
executes the current `web/app.js` renderer with only deterministic local
data. It checks:

| P004 task | Issue | Source-level evidence / remaining gap |
| --- | --- | --- |
| T-339 | #539/R11 | Two identically named PCs keep distinct stable `device.id` values even after list order reverses; access-mode, Bridge-preference and folder-assignment POSTs all retain the exact selected ID. **Post-#1068 main integration is blocked until merge.** |
| T-340 | #812 | FULL, CORE and ROOT display data is not a signed effective local-grant/Windows permission receipt. Untrusted `active` fields cannot promote the release-latched visual CORE/ROOT states. |
| T-341 | #539/R11 | Online, offline and missing online telemetry do not produce false-positive Broker readiness. Stale `adminBridgeReady=true` must not enable Bridge APPLY if the machine is offline, in SAFE mode, or on a non-Windows platform. The current two-state card text maps missing telemetry to “Çevrimdışı”, not an explicit “Bilinmiyor” category; typed dashboard contract normally supplies a boolean. |
| T-342 | #485 | With zero or one registered device and AUTO disabled, the screen continues to require explicit target selection; no rendering event makes an MCP tool grant. The account-level “Bağlı” pill may warrant wording review so users do not mistake it for a paired device. |
| T-343 | #539/R11 | Unicode/HTML-like names and platform data go to `textContent`, not card HTML. K03 candidate uses distinct within-list ordinal accessible names for duplicate visible names, while main does not yet. Ordinals are display hints and may shift when ordering changes; exact target selection must remain by stable ID. |
| T-344 | #539/R11 | #1068 candidate clears stale counts during pending load, 401 and 503. An added deterministic two-request race proves that a **late old 200 response cannot reintroduce private device cards after a newer 401** on #1068; current main still fails that regression. Recheck after #1068 is actually in main. |

Authorization remains in the backend (`src/mcp/create-server.ts` and
credential scoping), not in visible card labels or AUTO preferences. In
particular, the owner AUTO path requires exactly **one registered and
online** owner device in scope; a second offline registered device does
not authorize an implicit guess.

## Reproduce without a live device

```sh
# On the clean main-based K15 branch:
node test/delegated/k15/issue-539-device-ux.test.mjs

# With a separately fetched and verified detached #1068 candidate worktree:
K15_APP_SOURCE=/path/to/owner1068/web/app.js node test/delegated/k15/issue-539-device-ux.test.mjs
```

Results:

- Initial main exact `4e7db16...`: **6 PASS, 2 expected TODO, 0 unexpected FAIL**.
- Initial #1068 exact `94d38799...`: **8 PASS, 0 TODO, 0 FAIL**.
- Follow-up on the **same immutable sources** (new K15 tests only): main **8 PASS, 3 expected TODO, 0 unexpected FAIL**; #1068 **11 PASS, 0 TODO, 0 FAIL**. Added exact-target Bridge and folder action checks, ineligible Bridge APPLY checks and a 401-versus-late-200 privacy race. The third TODO is an actual main-only stale-data regression, not a claimed pass.

The TODOs are deliberate indicators of *unmerged* UI work, not test
successes. Passing the detached candidate does not prove the main branch
or deployed binary contains those fixes.

## Owner follow-up, with no path conflict

- **K03 / owner #1068:** review per-card accessible identity, stale
  counter invalidation and ambiguous account “Bağlı” wording. Any runtime
  edit remains in the UI owner's branch, not K15.
- **K13 / #1006:** discover the nested `.mjs` test explicitly in CI;
  merely seeing a job named `test` is not evidence the file ran.
- **ŞEF:** link T-339–T-344 source evidence into issue #539/R11,
  #812 and #485, keeping UI presentation separate from protected
  authorization and physical pairing acceptance.

The actual screen-reader accessibility tree, real browser keyboard focus,
375px mobile wrapping, live OAuth/pairing and physical Windows Agent/Broker
behavior were **NOT_RUN** by K15. Exact-head CI/owner review and main merge
are separate gates. These issue acceptance criteria remain open.

## P004 pool T-394 — target versus authorization negative matrix

After independently checking the 19 other KNN status files, K15 reserved
T-394 in `ekip/durum/K15.md` **before coding**. The new
`test/delegated/k15/target-versus-permission-matrix.test.mjs` runs the
actual pure `resolveOwnerDeviceTarget()` implementation on current main.

| Input | Pure target resolution | What this does **not** prove |
| --- | --- | --- |
| No registered devices, AUTO either way | `no_devices` | Neither online device nor authorization |
| One registered online, AUTO not approved | `selection_required` | No implicit selection merely from count |
| One registered online with explicit allow-implicit input | `selected` candidate | Must still authenticate the owner and evaluate effective tool scope |
| Two identically named PCs / normalization-equivalent names | `ambiguous-device` | Name does not establish stable identity |
| Two PCs, only one online, AUTO allowed | `multiple-devices` | Offline second device cannot authorize a guess |
| Exact stable ID matches, even if card order reverses | `selected` candidate | Does not establish device online or Broker ready |
| Exact ID exists but is offline | `selected` candidate | **Important:** this pure resolver does not enforce online tool admission; MCP has a separate online gate |
| ID outside selected folder or account list | `DEVICE_NOT_FOUND` | Never treat a visible folder label as a permission grant |
| Two normalization-equivalent folder names | `ambiguous-folder` | Cannot silently authorize one same-named location |
| Contradictory ID/name hints for device or folder | `DEVICE_NOT_FOUND` / `FOLDER_NOT_FOUND` | Must not prefer a convenient hint over the exact identity constraint |
| Single offline device in a folder, AUTO explicitly opted in | `selected` candidate with `one-in-folder` | **Still not** online admission or runtime permission |
| Known empty folder or unknown folder ID | `empty_folder` / `FOLDER_NOT_FOUND` | No fallback to a device outside the selected folder |

The test also inspects MCP admission source for exact one-owner-device,
online and credential-scope conditions; that inspection is **not** a live
MCP authorization request. No auth, Broker, CORE or routing source was
modified.

## P005 follow-up: T-479–T-484 (#539, #812, #485)

- **Current upstream main:** `b5a3f8840517d65ecbd6a018699c4c8bdde09987`
  (the #1102 S5 merge). A path-specific `git diff --name-only`
  against the preceding `4e7db16...` main for `web/app.js`,
  `src/product/device-target-resolution.ts` and `src/mcp/create-server.ts`
  was **empty**. The old/current source behavior is unchanged, not newly
  accepted in the installed product.
- **Owner #1068:** still Draft/unmerged at
  `94d38799e9e4b50fe84f7924e6fc84f90aeba090`; no owner source copied
  to K15's branch.
- **T-479:** #1110's exact-head CI run
  [42411906346](https://github.com/Naveax/Nexowire/actions/runs/42411906346)
  finished **7 jobs success**. That job list does not include K15's
  nested `.mjs` commands, so K15 test discovery in hosted CI is
  **NOT_RUN**, despite the workflow's success. An isolated VM rerun with
  current main's exact `web/app.js` still yields same-name a11y TODOs;
  owner #1068 distinct names PASS.
- **T-480:** Four `physicalConsole` local-enrollment and reported-active
  combinations (false, true/fresh, true/stale, inactive) cannot turn CORE
  or ROOT labels into a verified native input grant. Physical input is
  **NOT_RUN**, and no protected authorization code is modified.
- **T-481:** Null/undefined/false online telemetry suppresses stale
  `adminBridgeReady` and Bridge APPLY; only a known-online machine yields
  a Broker-ready *report*. The UI still calls unknown telemetry
  `Çevrimdışı`, not an explicit third card state; owner can assess wording.
- **T-482:** AUTO enabled with zero or two same-named devices is a saved
  preference, not implicit pairing or an action. Render sends no POST;
  actual MCP admission still separately requires scoped online ownership.
- **T-483:** With two identical long Unicode names, the #1068 candidate
  distinguishes action names on each render, unlike main. A separate
  expected TODO isolates **ordinal label instability**: for the same
  `device-alpha` on reorder, the CORE accessible name changes from
  `Aynı PC · cihaz 1 · ...` to `Aynı PC · cihaz 2 · ...`. The target ID
  remains stable, so this is an owner a11y/identity *review finding*, not
  proof of a wrong-machine dispatch or native permission bug.
- **T-484:** K10 browser evidence boundaries and actionable card cases
  are separated in `P005_BROWSER_ACCEPTANCE.md`; no K10 branch files
  or hosted screenshots were changed/created here.

Source-only verification (Node 24.22.1): current main UI **11 PASS,
5 expected TODO**; detached #1068 UI **15 PASS, 1 expected TODO**;
main real pure resolver **13 PASS, 0 FAIL**. Current owner candidate's
one TODO is the new ordinal stability observation, not an accepted fix.
K15's entire P005 matrix remains unverified on a physical Windows
machine, live account and assistive technology.

## P006 follow-up: T-619–T-624 (#539, #812, #485, #1006)

- **Current upstream main** after #1135: `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`.
  `git diff --name-only b5a3f884..52d452f -- web/app.js web/index.html
  src/product/device-target-resolution.ts src/mcp/create-server.ts`
  was empty; source behavior did not change. Owner #1068 still open Draft
  at `94d38799e9e4b50fe84f7924e6fc84f90aeba090`.
- **T-619 (real RED on main):** Two identically named devices are
  associated with distinct folders. With the warehouse selected, a newer
  fetch returns the correct `machine-b`, then a slower older fetch moves
  `machine-a` into that folder. On current main the **older** response
  erroneously overwrites the card ID (`machine-b` -> `machine-a`), even
  though the selected folder remains the same. Reproduced as a deliberate
  TODO on current main, PASS on detached #1068 (load-generation fence).
  This is a stale-response/identity UI bug, not proof of an erroneous
  Agent dispatch. The screen-reader label of the kept card is checked
  as well.
- **T-620:** Two same-named FULL devices differ in localConsole
  enrollment/active report; both still show CORE pending, `aria-pressed`
  false and no completed-input claim, despite FULL badge. No actual native
  permission is inferred from UI fields; local source VM PASS.
- **T-621 (owner UX decision/RED):** An authenticated dashboard fetch
  returning **zero registered devices** renders the explicit empty-list
  recovery hint and enabled connect button, yet sets the global success
  pill to **`Bağlı`** on both current main and #1068 candidate. This may
  mean *account session connected*, but can be mistaken for *device
  paired*. An expected TODO requires an account-vs-device recovery label;
  K03/owner should decide exact wording. No false physical pairing was
  claimed by K15.
- **T-622:** `resolveOwnerDeviceTarget()` independently returns
  `ambiguous-folder` for two normalization-equivalent folder names,
  regardless of input order. An explicit correct folderId/deviceId
  selects the intended candidate; wrong folderId/deviceId rejects with
  `DEVICE_NOT_FOUND`. Pure resolver is not authorization or grant.
- **T-623:** K15 PR #1110 previous exact HEAD
  `fd687a145bc08e51cf5ce2cbf136bbe90d727a3a` automated CI
  [42473857473](https://github.com/Naveax/Nexowire/actions/runs/42473857473)
  completed **7/7 success**, but the seven jobs' step-name inventory
  contains **no K15 `test/delegated/k15/*.mjs` invocation**. K13
  [#1134](https://github.com/Naveax/Nexowire/pull/1134) hosted auxiliary
  tests include K09/K16, **not K15**; its 4/4 job PASS cannot be borrowed
  for K15. These new nested K15 tests are therefore **hosted NOT_RUN**.
- **T-624:** #1068 source remains Draft/unmerged; T-339/T-479/T-624
  post-merge exact-main retest is **BLOCKED**, no manufactured acceptance.

Node 24.22.1, current main web/app.js: **12 PASS / 7 expected TODO**;
owner #1068 read-only web/app.js: **17 PASS / 2 expected TODO**;
pure main resolver: **14 PASS / 0 FAIL**. Expected TODO failures are not
PASS. The two owner candidate TODOs are ordinal-name instability and
ambiguous zero-device `Bağlı` recovery wording; existing authenticated
device routing/physical input admission remains out of scope. New
T-619 stale-folder race and the #485 empty-list symptom are directly
reproducible from actual UI source with deterministic fake fetch/DOM;
real Chromium, Windows, screen reader, live enrollment and device
acceptance remain **NOT_RUN**.

### P006 pool T-666 — heading versus stable target ID

After reading all 19 other KNN records and finding no T-666 claim, K15
reserved T-666 in `ekip/durum/K15.md` **before writing the fixture**.
The added regression filters two same-named devices into a single
folder, then reverses the original array order. It checks that the
visible Unicode/HTML-like heading is stored as literal text, the
per-row stable ID remains `device-b`, and the actionable screen-reader
label contains the heading and continues to address that same device.
Two actual Access-mode POSTs are checked for exact ID. It isolates
one current-main expected TODO (generic unscoped aria label) versus
owner #1068 candidate PASS. No actual cross-device POST was reproduced;
the residual risk is **user-facing heading/action identification** until
#1068 is reviewed and merged.

Extended Node24 source-only total: current main UI **12 PASS / 8
expected TODO**, owner #1068 UI **18 PASS / 2 expected TODO**, pure
main resolver **14 PASS / 0 FAIL**. This is not real browser or physical
input acceptance. T-666 is source QA evidence only, pending second
19-KNN ownership sweep immediately before final claim of completion.

Reproduction:

```sh
node test/delegated/k15/target-versus-permission-matrix.test.mjs
```

Initial result on current main `4e7db16...`: **9 PASS, 0 FAIL, 0 TODO**. Follow-up on the **same** main: **13 PASS, 0 FAIL, 0 TODO**.
This narrows #539/R11 and #812 evidence, but leaves live identity,
permission and physical input-grant acceptance to the appropriate owner.
