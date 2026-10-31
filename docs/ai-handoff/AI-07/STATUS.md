# AI-07 status (2026-10-31)
- **Status:** REVIEW (source-only), **production NO-GO**.
- Source: PR #859 OPEN/DRAFT, original HEAD `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9`, source CI `40547392793` SUCCESS.
- Original base main: `bd519ee52d56956edfddb1e06bb0856e54e50419`; current main: `a19a228dc6f19fd484cf935e941a00ea625233f8`. Diverged 11 ahead / 32 behind.
- Dedicated branch: `ai/07-isolation-worker-20261031`, child of #859's exact HEAD; this is not a main merge or rebase.
- New exact HEAD and CI: query the live child PR/Actions; never substitute source SHA/run ID.
- Next: independent native OS worker, dispatcher admission, descendant/revoke negative tests, disposable Windows and Linux verification.


## 2026-10-31 continuation: hostile JS evidence handling
- `task-os-sandbox-policy.ts` now reads intent and OS report fields through own data descriptors rather than evaluating plain-object getters; malformed objects, sparse/hostile argv, environment symbols, and throwing Proxy prototype traps fail closed.
- Any malformed non-null report or own `mutationState` (including terminal-looking values) demands `RECONCILE_REQUIRED`, never replay. Inherited spoofing is rejected.
- This is still **source-only**. JavaScript Proxy reflection hooks are inherently executable; the true native trust boundary must authenticate serialized bytes and independent kernel readback outside the JS object graph.
- Added `test/ai07-sandbox-hostile-input.test.ts` negative tests. Do not equate unit tests with Windows AppContainer isolation.

## 2026-10-31 native probe hardening
- Linux disposable probe now atomically closes **every** inherited fd (including 0/1/2), verifies EBADF on those streams, removes seccomp write permission, and prints the static success marker in the outer parent only after successful wait/readback. Existing native compile and opt-in smoke still distinguish physical execution from source.
- Windows disposable probe now explicitly links Advapi32 for MSVC, requires TokenPrimary and a Job KILL_ON_JOB_CLOSE flag in addition to AppContainer/low-integrity/no-breakaway checks. None of these individual checks authorize production confinement.
- Exact-head CI is tracked externally; no CI workflow reruns and no production permission.


## 2026-10-31 source continuation
- Added monotonic bounded readiness and bounded wait/kill of the disposable Linux probe's *own* child, no arbitrary PIDs.
- Added a Windows-only isolated MSVC build and negative CLI test under test/ai07-sandbox-windows-msvc-p07.test.ts. It is unsupported on Linux, not physical PASS.
- Existing PR #990 and AI-07 branch kept; all code remains deny-only, no service/Agent/production effects.
