# Nexowire cross-project reliability program | 2026-10-18

**Scope**: incidents and obstacles compiled from user-supplied reports spanning LG G3/Nura Linux, Debian/Win7, Syntavra, Roblox Studio, PSMatrix, NXB V11, GuardAdaptive, Catalog, ReVoltVPN, native Search Tool, crypto model-bot and Scale v2/HyperScale. This ledger covers common Nexowire infrastructure; it does **not** assert that every application's distinct bug will be fixed by Nexowire.

**Hard boundaries**: Provider-side OpenAI tool safety decisions, OS UAC/Windows integrity, physical firmware recovery, separate vendor platforms, third-party OAuth account ownership and device-specific failures cannot be overridden by local Nexowire CORE/FULL mode. Diagnosing, safely classifying and explaining blocked work is deliverable; bypassing security controls is NOT.

## 22 work items, each with objective exit conditions

| ID | Priority | Workstream | Initial state | Release/acceptance evidence required |
|---|---|---|---|---|
| R01 | P0 | Error Contract v2: transport/agent/tool/process/task outcomes | Partial | Correlation IDs, stable origin and non-sensitive reason; fail-closed provider ambiguity; forced-loss test |
| R02 | P0 | Agent-side operation journal | Source candidate in this PR | Restart/crash WAL, duplicate mutation denied, corrupt journal deny, no secret payload |
| R03 | P0 | Operation status/reconciliation API | Source candidate in this PR | Operator-only Agent status, correlated Hub idempotency, evidence when Agent offline |
| R04 | P0 | Explain account/device/Full/Root/Core/Windows authorization | Partial | Simulate missing grant and ensure structured deny + no execution |
| R05 | P0 | Path/USB constrained grants | Partial | Exact target volume identity, time-boxed and revocable read/write separate, no sibling disclosure |
| R06 | P1 | Heartbeat, reconnect, route and epoch recovery | Partial | Two-device chaos test, disconnected device status, no auto duplicate mutation |
| R07 | P1 | Process Manager v2 and child-tree ownership | Partial | Bounded sessions, stale process kill only by owner, original pending/running preserved |
| R08 | P1 | Shell/WSL argv and exit contract | Partial | PowerShell/CMD/WSL quoting, path, UTF-8, stderr, real exitCode and timeout |
| R09 | P1 | GUI/Broker/console permissions and focus | Partial | Explicit active grantId, HWND provenance, focus conflict safe stop, no covert input |
| R10 | P1 | Git/device/artifact SHA checkpoint sync | Partial | Exact commit and artifact digest to specific device and acceptance proof |
| R11 | P2 | Reliability Doctor UI | Missing consolidated UI | Operator can locate request by ID and see transport/provider/agent/task stages |
| R12 | P1 | Scale v2 100+ authenticated sockets / minute/day quotas | Staging only | 2 off-network PCs, real live OAuth/registration, 600/min and 24h acceptance |
| R13 | P0 | Upstream OpenAI / MCP policy diagnostics | Not complete | Distinguish "not delivered", provider rejection and Agent rejection, do not infer hidden rules |
| R14 | P0 | Codex OAuth compatibility | Not production accepted | Auth-code/PKCE, discovery, resource, refresh/logout and denied session test |
| R15 | P0 | Cross-chat artifact continuity | Not complete | Persistent file location, SHA, scope/access, new-session retrieval with explicit approval |
| R16 | P0 | Native Windows file-picker/UIA bridge | Partial | Exact owner-approved HWND, disabled/hidden control denial, no default-desktop takeover |
| R17 | P1 | Windows/WSL/USB/Python/CUDA/Ollama environment diagnostics | Partial | Drivers, adapter transitions, prerequisites and exit evidence; no unsafe automatic fixes |
| R18 | P0 | Work-progress evidence and queue watchdog | Not complete | Distinguish PID running from actual completed work; queue and result timestamps |
| R19 | P1 | Agent/Broker lifecycle manager | Partial | Safe update/rollback, version compatibility, pinned binaries, zero-downtime where possible |
| R20 | P1 | Idempotent append/compare-and-swap | Partial | Atomic expected-offset/hash precondition, no duplicate write after lost ACK |
| R21 | P1 | Physical hardware acceptance harness | Partial | Real USB/gamepad/VM proof distinguished from synthetic test PASS |
| R22 | P1 | Source/CI/provider and release gates | Partial | No “final” absent required actual tests, artifacts, operator identity and independent review |

## Four non-interchangeable success states

1. **Source tested:** isolated unit/regression/CI passes.
2. **Staging accepted:** representative connected runtime scenario passes.
3. **Production deployed:** actual running agents upgraded with rollback.
4. **Incident closed:** original reported scenario reproduced and re-tested successfully (or formally external/blocking, with guidance and evidence).

Do not label any work item fully complete until **incident closed**. The current PR changes R01/R02/R03 **in source only**, and R08 task outcome metadata. Work on other issues is a backlog, not implemented work.

## Representative regression matrix

- Lost acknowledgement: remote program starts but MCP call yields `MUTATION_STATE_UNKNOWN` -> no auto replay; query Agent journal and Hub status to determine known/unknown.
- Source edit blocked by OpenAI before tool submission -> distinguish upstream safety refusal; do not generate alternate encoded commands to evade.
- USB file API `PATH_DENIED` vs shell with user privileges -> respect separate explicit grant, explain rather than use shell as a bypass.
- Console `owner-full-access` but `active=false` / `grantId=null` -> show local physical-console consent needed.
- `UNAVAILABLE/Connection failed` on one device but not other -> correlate heartbeat, hub/agent epoch and request IDs.
- Shell transport says OK but Python/PowerShell `exitCode=1` -> taskSuccess false.
- Bot shows `RUNNING` while queue/result counters do not move -> unresponsive progress state, no false completion percentage.
- Native Windows file selector cannot be controlled by browser DOM actions -> use authorized UI Automation only and verify window.
- Codex login fails `AuthRequiredError` while ChatGPT plugin works -> separate OAuth client/issuer/scopes and exact callback.
- Incompatible RTX CUDA/PyTorch or missing `usbipd-win` -> environment error with owner-reviewed remediation.
- LG Download Mode/fastboot not functioning -> device driver/bootloader issue, do not conflate with Nexowire transport.
- CI success on synthetic fixtures but hardware absent -> forbid production acceptance claim.

## Blockers outside Nexowire authority

OpenAI provider safety policy; vendor-hosted OAuth account state; Windows UAC and physical console grants; Windows driver (e.g., USB PnP), LG LAF/ABOOT/firmware, Linux boot chain; missing external licenses/certificates; actual customer environment behavior; model validity and trading outcomes. These are NOT Nexowire bugs unless independently reproduced as such.

Maintain this as an auditable scope and avoid opening 22 unrelated concurrent PRs. First correct R01/R02/R03 with source + real two-PC upgrade acceptance; then prioritize incident impact.
