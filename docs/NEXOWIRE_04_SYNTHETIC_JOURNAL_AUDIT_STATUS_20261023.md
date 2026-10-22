# #04 CORE UI status second pass: synthetic Journal/Audit/consent fail closed

**23 October 2026 — DRAFT source-only child of #808.**
No installed Broker, Windows token, UAC, ACL, native Agent, D1, VM, or
task/effect action was executed or modified.

## Exact cross-owner evidence

- **#808** HEAD `b69e4ac5664b279e7c9a854a1946db8b433097cf`,
  Actions `39841919586` **7/7 SUCCESS**. The unchanged #23 #726
  CORE card real DOM QA was independently cross-run on exact #808:
  source blob `e63a070c73c1799b77f39fd621033cdf8ccfcc30`,
  **2/2 PASS**, without editing #23 tests. This proves stale owner
  epoch and missing final trust flags are blocked, not a native HIGH token.
- **#837** HEAD `1d2a455803407b077d6838b51a3a4b0d685150e8`,
  Actions `39864371572` **FAILURE**. #16 QA inventory rightly labels
  #808 a SOURCE-only candidate; Node24 source check, independent
  acceptance and Windows durable-process jobs failed. No staging or
  physical acceptance.
- **#826** HEAD `f9411fb09633c139920e7166c0901b85fdf3e9e2`,
  Actions `39862856414` **FAILURE** (Node24 check).
  #01 actual `executeDurableRunbook` owner now rejects native-capable
  `task_graph` before callbacks with `RECONCILE_REQUIRED` and
  preserves UNKNOWN on retry. The real installed off-host linearizable
  CAS/native-effect authority is still absent; do not infer completion
  from a runbook journal status.
- **#825** independent #45 `projectTaskEvidence` head
  `88668d1f3d48a3c474da594ce270a3aae6e93e60`, Actions
  `39862809072` **FAILURE**: its source-only projection intentionally
  exports literal `completedVerified:false`,
  `coreEffective:false`, `mayDispatch:false` even when Journal says
  succeeded, Audit says succeeded, a serialized receipt has
  `verified:true`, or synthetic CAS says committed. That projection
  is NOT wired to `web/app.js` and is not signed native evidence.
- **#823** QA #49 release matrix head
  `94e93a5f5860b9854605d68449f8e7e93ce07c2a`,
  Actions `39862751822` **SUCCESS** for docs-only NO_GO assessment,
  not an installed security proof. #539 and #780 coordination remain.

## The actual newly reproduced UI gap

At #808, both `getDeviceTier` and the CORE card demanded positive
owner/grant generation and two final native/CAS booleans. The current
ControlPlaneService dashboard **does not emit** owner/grant epoch or
physically accepted final native and external CAS fields; the browser
does not verify signatures. A fully forged browser snapshot with
ALL old CORE booleans, matching invented epoch/generation, synthetic
Journal succeeded/verified, Audit succeeded/verified, a fake consent
receipt and cloned runbook completed/UNKNOWN **did reach the positive
CORE effective display**. This is a misleading status UI, **not**
an actual high-token executor escalation. The new #04 negative
`#49 synthetic Journal/Audit and browser-local consent...` was
**RED 5 PASS / 1 FAIL** on unmodified #808 source, with actual
`coreEffective:true` where paused was required.

## Narrow Access-owned fix

`web/app.js` now retains the existing owner epoch / generation and
protected Broker/native/CAS field comparisons but adds explicit
`physicalCoreStatusVerifierInstalled = false` in **both** the tier
selector and the actual CORE DOM render block. This is a P0
physical-acceptance release latch: the positive status cannot be
rendered from any browser flags or source-only Journal/Audit/consent
while there is NO deployed, independently reviewed signed installed
Windows HIGH token and off-host rollback-independent atomic native
effect verifier. The latch must NOT become true from client JSON or
another boolean receipt. A later **separately reviewed server-side
cryptographic verified-current status implementation** is required
before displaying CORE EFFECTIVE again.

`test/access/core-ui-owner-epoch-render.test.ts` adds exactly one
actual render/tier negative on all-true forged Journal/Audit/consent
plus cloned runbook UNKNOWN. It now passes; #23 QA is untouched.
No native dispatch, status-to-authorization conversion, approval
elevation or per-command Windows UAC is introduced. Legitimately
installed signed CORE would continue to require one proper initial
local UAC, not a prompt for every subsequent command, after actual
physical policy acceptance. While unaccepted, UI correctly remains
`CORE KAYITLI • YETKİ BEKLEMEDE` / FULL tier.

## P0 still NO_GO

#271 inherited writable installation ACL, #551 signed installed
Broker/import/updater/rollback, #587 off-host atomic CAS+revocation,
#617 actual protected HIGH process token, #786 path/root hostile
real-API negative, and #826 source+hosted CI unresolved. #837 QA
and #49 release matrix remain independent; no RED test softened.
