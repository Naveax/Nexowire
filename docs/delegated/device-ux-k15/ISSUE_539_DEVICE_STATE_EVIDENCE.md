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
| T-339 | #539/R11 | Two identically named PCs keep distinct stable `device.id` values even after list order reverses; the per-card access-mode request retains the intended ID. **Post-#1068 main integration is blocked until merge.** |
| T-340 | #812 | FULL, CORE and ROOT display data is not a signed effective local-grant/Windows permission receipt. Untrusted `active` fields cannot promote the release-latched visual CORE/ROOT states. |
| T-341 | #539/R11 | Online, offline and missing online telemetry do not produce false-positive Broker readiness. The current two-state card text maps missing telemetry to “Çevrimdışı”, not an explicit “Bilinmiyor” category; typed dashboard contract normally supplies a boolean. |
| T-342 | #485 | With zero or one registered device and AUTO disabled, the screen continues to require explicit target selection; no rendering event makes an MCP tool grant. The account-level “Bağlı” pill may warrant wording review so users do not mistake it for a paired device. |
| T-343 | #539/R11 | Unicode/HTML-like names and platform data go to `textContent`, not card HTML. K03 candidate uses distinct within-list ordinal accessible names for duplicate visible names, while main does not yet. Ordinals are display hints and may shift when ordering changes; exact target selection must remain by stable ID. |
| T-344 | #539/R11 | #1068 candidate clears stale counts during pending load, 401 and 503; current main lacks this presentation reset. This must be checked again once #1068 is truly in main. |

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

- Main exact `4e7db16...`: **6 PASS, 2 expected TODO, 0 unexpected FAIL**.
- #1068 exact `94d38799...`: **8 PASS, 0 TODO, 0 FAIL**.

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

The test also inspects MCP admission source for exact one-owner-device,
online and credential-scope conditions; that inspection is **not** a live
MCP authorization request. No auth, Broker, CORE or routing source was
modified.

Reproduction:

```sh
node test/delegated/k15/target-versus-permission-matrix.test.mjs
```

Result on current main `4e7db16...`: **9 PASS, 0 FAIL, 0 TODO**.
This narrows #539/R11 and #812 evidence, but leaves live identity,
permission and physical input-grant acceptance to the appropriate owner.
