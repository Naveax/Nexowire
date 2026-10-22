# #04 Access → #23 CORE UI stale-owner-epoch handoff

**2026-10-22. Source-only DRAFT child of #795.**

## Exact independent proof / ownership
- #795 HEAD `70e9735007b648db83c2a6fa891ad624a8ef224f`,
  Actions [#39823364109](https://github.com/Naveax/Nexowire/actions/runs/39823364109) **SUCCESS**;
  its signed task/worktree source review always returns
  `canLaunchElevated:false`.
- #726 HEAD `50491525249bcc1f5c47b90f23890b2b3062e33d`,
  Actions [#39823764746](https://github.com/Naveax/Nexowire/actions/runs/39823764746)
  **FAILURE** on Node24 `npm run check` and
  `test/qa/core-card-approval-pref-only.test.ts`. Node22 was cancelled;
  Windows browser-live, macOS, Linux, WSL2 and Security Operational
  succeeded. The #23 regression executes **actual** `web/app.js`
  render and tier code and expects CORE PAUSED despite stale
  ownerEpoch and missing atomic final native HIGH evidence. It exposes
  a genuine UI false-positive from client snapshot, not a demonstrated
  OS privilege escalation.
- Ownership: `web/app.js` CORE preference/render UI was last modified
  under #04 owner commit `48f117f63d8c8e25491a9bb210dc1f0bf8a3544d`
  in #621, so a small correction in #04's own isolated source branch
  is in scope. **No #23 QA source or test file was modified.**
- #786 `workspace.snapshot` linked-worktree out-of-root actual-API
  negative remains RED at Actions #39817020745; separate #05 owner,
  not changed here.

## Exact UI bug
1. `getDeviceTier` returned `persistent` if
   `persistentMaintenance.active===true` even when
   `effective:false`.
2. CORE card's `coreEffective` depended only on six booleans:
   `effective`, authoritySource, enrollment, native token, Broker ACL,
   Broker version. It never compared signed-current owner epoch,
   generation, final native token reattestation or external atomic
   native effect witness. A 1ms-old ownerEpoch 4 snapshot despite
   current ownerEpoch 5 rendered `CORE YÖNETİCİ ETKİN`,
   pressed true / active class.

## Minimal fail-closed #04 source fix
`web/app.js` changes **only** these two local render gates:

- `persistent` tier now requires the **same** strict CORE display
  predicate, not `active` alone.
- CORE must be explicitly enabled, active, effective with expected
  independent protected Broker authority fields; owner epoch and
  generation must be positive safe integers and equal the current
  server snapshot `device.currentOwnerEpoch` and
  `device.currentGrantGeneration`. Also
  `core.finalNativeEffectVerified===true` and
  `core.externalCasAtomicCommitVerified===true` are required.
  These last fields must originate from a separately physically
  accepted high-token installed Broker and **deployed** independent
  atomic external CAS native-effect proof, never a caller flag, Agent
  readiness, #712 reserve-only permit or local approval.
- Current dashboard `ControlPlaneService.dashboard` emits neither
  authenticated epoch pair nor physically accepted final effect
  fields. Therefore **these gates fail closed by design**, rendering
  CORE `KAYITLI • YETKİ BEKLEMEDE` / tier FULL until backend/native
  authority owners provision real proof and trusted server readback.
  Browser booleans alone do not and cannot validate Ed25519 or prove
  Windows HIGH. This is display logic only, not OS dispatch permission.
- Existing preference handler still merely posts
  `core-preference-v1` and reloads, with **no** per-command UAC.
  Once a real signed protected CORE Broker has been installed through
  legitimate one-time local UAC, later authorized commands must not
  need UAC per operation; native/OS permissions and external atomic CAS
  nevertheless remain mandatory.

New own `test/access/core-ui-owner-epoch-render.test.ts` extracts and
executes the **actual** current `web/app.js` tier/card snippets.
Negatives cover stale epoch/generation, old active true but effective
false, missing final physical CAS fields, wrong-typed epoch/boolean
and 1ms-old forged all-six-true client snapshot. The independent #23
QA remains untouched and must be rerun against this child branch
before declaring its prior CI failure fixed.

**Production NO-GO**: #271 inherited writable ACL, #551 signed
installed Broker/import/updater, #587 remote rollback-independent
CAS/native linearization, #617 protected actual HIGH token, plus #786
real Git-worktree root escape. No live UAC, Broker, VM, OS ACL, Agent,
remote CAS, user files or production database was modified.
