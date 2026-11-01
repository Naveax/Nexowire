# Device list / selection UX: source-backed contract inventory

Snapshot: 2026-11-01, upstream `Naveax/Nexowire` `main` at
`93b6df33ef58610dcfdf3584bfe774e5afa7df4d`.

This is a **UI and offline test** inventory, not permission to change MCP
routing, OAuth, Agent or Broker behavior. No real user, browser or device
was connected. The dashboard's device cards are settings controls; they are
**not** themselves the MCP tool-target picker.

## Current sources and user-visible states (T-085)

| State | Data / boundary | Actual user-facing behavior | Regression |
| --- | --- | --- | --- |
| Loading | `web/index.html` `#devices`, `web/app.js` `load()` | Initial “Cihaz listesi yükleniyor…” and a check-in-progress pill | Static source review only |
| No registered devices | `src/product/control-plane-contract.ts` `UserDashboardSnapshot.devices = []` | “Henüz bağlı cihaz yok…”; total 0, online 0 | Offline renderer test |
| Connected but selected access mode empty | `web/app.js` `selectedDeviceFilter` | Nonzero total is retained; generic filtered empty message | Offline renderer test |
| Folder filter with no matching cards | `web/app.js` `selectedFolder` | No cards, but total reflects all registered devices | Offline renderer test; copy gap below |
| One or several cards | Stable `device.id`, distinct `device.name`, `platform`, `folderId` | Each card has own ID, settings controls and online indication; duplicate visible names possible | Offline renderer test |
| Device offline | `device.online !== true` | “Çevrimdışı”; last Broker readiness cannot become a healthy state | Offline renderer test |
| Device online, Broker unverified | `privilegeMode` / `adminBridgeReady` | “Broker doğrulanmadı”; no elevated-success claim | Offline renderer test |
| Broker readiness notice | Online + broker mode + ready flag | “Broker hazır bildirimi”; text explicitly says this is not an applied-command receipt | Offline renderer test |
| Auto selection off | `autoSelectDevices !== true` | UI says explicit selection is required | Offline renderer test |
| Auto selection on | Owner preference, not a security proof | UI says only one suitable device and MCP integration must be independently checked | Offline renderer test; routing still server-owned |
| Dashboard 401 / transport failure | `load()`, `/api/v1/me/dashboard` | Login-required or connection-error panel, without a fabricated empty device list | Static source review only |

Dashboard fields originate in `src/product/control-plane-service.ts` and are
described by `src/product/control-plane-contract.ts`. The actual MCP target
contract is implemented separately by `src/mcp/create-server.ts`
(`resolveDevice`, `devices_list`) and
`src/product/device-target-resolution.ts` (`resolveOwnerDeviceTarget`).
The latter may require an explicit choice even for one device, while the
MCP server's owner AUTO path requires **exactly one registered owner device**
which is online, not merely one online card among several offline devices.
Neither displaying a card nor choosing a folder grants permission.

## Device mis-selection / state safety (T-086, T-087)

- An identity must be shown as *name plus stable ID context*, not inferred
  from a possibly duplicated name. The existing controls dispatch `device.id`
  from the card closure; the offline regression dispatches the second of two
  identically named cards and checks the exact outgoing ID.
- Offline stale `adminBridgeReady: true` / `privilegeMode: broker` cannot
  render the device as online or report live Broker readiness. This is
  checked against the actual `render()` source.
- **Open UI accessibility gap:** per-card `CORE ayarlarını aç`,
  `PC Settings` and Bridge actions repeat identical accessible names across
  different devices. The card's displayed name is not linked with those
  buttons via an accessible naming relation. To resolve, the owner of
  `web/app.js` should add device-specific accessible context to per-card
  controls without modifying capability/routing logic. A focused test
  documents the **expected failing condition as TODO** until the UI owner
  resolves it on upstream `main`. K03's unmerged candidate now includes
  distinct per-card ordinal names (see differential check below). This
  task's path ownership does not permit editing `web/app.js`.

## Copy proposal for one / many / filtered devices (T-088)

No runtime copy was changed by K15. Suggested localized UI messages for
the dashboard owner to review:

| Condition | Proposed text |
| --- | --- |
| No registered devices | “Henüz bağlı cihaz yok. Önce bir cihaz bağla.” |
| Filter or folder with no visible device, but registered devices exist | “Bu filtrede cihaz yok. Tümü görünümüne dön veya başka klasör seç.” |
| Several devices have the same display name | “Cihazın adını ve ayırt edici kimliğini kontrol ederek işlem yap.” |
| Several registered devices, AUTO off | “Birden fazla cihaz var. İşlemden önce hedef cihazı açıkça seç.” |
| AUTO enabled but online/offline mix | “Otomatik seçim, yalnız sunucunun doğruladığı tek kayıtlı ve çevrimiçi cihaz için geçerlidir.” |
| Offline device visible | “Bu cihaz çevrimdışı. Önce bağlantısını doğrula; önceki Broker durumu canlı kanıt değildir.” |

The dashboard is not allowed to promise that an offline card will be
selected as the target of an MCP mutation. The proposed text should be
reviewed against the exact server response and authenticated scope before
shipping. Do not implement an implicit target fallback in web code.

## Long names, Unicode and HTML safety (T-089)

The deterministic test uses an emoji, Turkish diacritics, Chinese
characters, a long suffix and HTML-like text. Current `web/app.js` writes
`device.name` and `device.platform` with `textContent`, not string
interpolation inside `innerHTML`. That protects the text sink from markup
execution in this code path. It **does not** prove visual wrapping,
screen-reader pronunciation, RTL layout or 375px mobile rendering.

## Non-authority UX proposal and acceptance boundary (T-090)

1. Give per-card actions a stable accessible relationship to the device
   name **and distinguishable identity**; duplicate names must remain
   distinguishable even when rendered on separate cards.
2. Keep selection feedback separate from authorization: display a chosen
   target only after an explicit/server-verified ID match, and never imply
   that visible device count is authorization.
3. Use distinct empty states for account empty vs filtered empty vs
   authentication/transport failure. The existing folder-filter empty
   state uses the access-level message and needs copy review.
4. Keep stale offline/Broker telemetry descriptive, never styled as a
   verified privileged capability.

**Required additional acceptance before UX release:** real browser DOM
accessibility-name and keyboard tests; 375/768px wrapping and screenshot
inspection; authenticated dashboard and MCP responses; Windows physical
Agent/Broker confirmation. All are `NOT_RUN` in this K15 slice, and no
live mutation route was exercised.

## Reproduction

```sh
node --test test/delegated/k15/device-card-contract.test.mjs
```

This runs a limited synthetic DOM surface around the real `web/app.js`
`render()` implementation without external dependencies or network. It
tests registered/filtered/duplicate ID/offline/ready/Unicode/AUTO display
contracts: eight PASS cases plus one explicitly TODO accessible-label case.
It deliberately excludes browser layout, keyboard accessibility,
MCP route admission and actual device operations.

## P002 follow-up: K03 candidate and additional negatives (T-210–T-214)

The upstream `main` source remains the reference baseline above. K03's
unmerged UI-only branch `k03/panel-state-qa` at exact head
`96fa340...` was checked in a **detached read-only Git worktree**.
It includes a `deviceLabel` containing a within-list ordinal for repeated
device names, as well as a dashboard loading/error reset. This is a
candidate result, **not a merged/released behavior**.

| Source under test | 15 synthetic renderer contracts | Meaning |
| --- | --- | --- |
| Upstream `main` `93b6df33...` | 12 PASS, 3 known TODO | Unique per-card accessible action names, pending reload reset, 401/503 reset not yet in main |
| K03 candidate `96fa340...` | 15 PASS, 0 TODO | Candidate addresses these source-level conditions; no browser or CI proof |

Use the **same K15 test file** for both sources, without copying K03 files
into K15's branch:

```sh
node test/delegated/k15/device-card-contract.test.mjs
K15_APP_SOURCE=/path/to/k03-readonly/web/app.js node test/delegated/k15/device-card-contract.test.mjs
```

The override path must point to a separately verified, local, read-only
Git worktree at a known exact SHA. It is not used in product code.

Additional behaviors now covered:

- **T-210:** Repeated CORE, Bridge, PC Settings and folder controls have
  distinguishable accessible names in the K03 candidate; upstream main
  still reports an expected TODO. An actual accessibility tree is not
  asserted by this fake DOM.
- **T-211:** Two identically named PCs in the same folder retain their
  exact `deviceId` on assignment, even when the source card order changes.
  The ordinal is presentation-only and may change after reorder; it must
  never substitute for the stable backend ID.
- **T-212:** An offline FULL card with stale CORE, ROOT and Broker-ready
  flags remains unverified; the separate Broker apply control is disabled.
- **T-213:** Pending reload and 401/503 responses cannot reuse previously
  successful device counts in the candidate; baseline TODO explicitly
  prevents overstating merged behavior.
- **T-214:** `autoSelectDevices` is a displayed owner preference, while
  `src/mcp/create-server.ts` separately requires a unique online owned
  device and enforces credential restrictions. Displaying a card is not
  authorization; an exact backend choice is still necessary.

**Remaining acceptance gaps:** K03 candidate has not been merged to
upstream main; exact-HEAD CI, real browser + keyboard/screen reader,
mobile screenshots, and physical Agent/Broker checks remain `NOT_RUN`
in this K15 audit. The K15 source files are test and documentation only.
