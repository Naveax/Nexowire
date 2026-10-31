# v1.0.8 Coordinator Child-PR Lineage Audit

**Scope:** Read-only GitHub HEAD/base consistency. It is **not** a CI pass, Git merge permit, CORE claim or deployment authorization.

The original 16-PR merge rehearsal checks Git tree conflicts. This additional independent check catches a separate hazard: a child PR can have green CI at an **older** base SHA while its parent AI continues committing. GitHub will still show the child as a Draft PR, but its earlier CI cannot attest the new parent code.

## Live usage

```bash
node scripts/coord-v108-child-lineage.mjs
```

The tool reads and then re-reads exactly the parent and child metadata of three current integration pairs:

| Parent | Child | Role |
| --- | --- | --- |
| #990 | #1004 | Rename AI-07 Windows diagnostic without destroying #980 AppContainer fixture |
| #980 | #1005 | Preserve #1002 PID-incarnation journal fix inside CORE authority |
| #985 | #1007 | Compose D1 native-claim migration and the unchanged AI-08 P0 regression |

A pair is blocked if either PR is closed/non-Draft, the child's base branch is not the exact parent's head branch, its base SHA is older than the parent's current head, metadata is malformed, or either HEAD moves during the double-read. Errors are explicit. No automatic rebase, force push, CI dispatch or external side effects are performed.

The only non-blocking outcome is `LINEAGE_ALIGNED_REVIEW_REQUIRED`, which **does not authorize merge or deployment**. It is not evidence that the source code is compatible, that the frozen SHA's CI passed, or that protected native Windows owner/session authority was independently witnessed.

## Local fixture regression

```bash
node --test --import tsx test/coord/coord-v108-child-lineage.test.ts
```

Six tests cover aligned-but-not-approved lineage; stale parent HEAD; forged/incorrect base reference; a non-Draft child; movement during the second read; and duplicate PR identities. Fixture outcomes are marked `UNTRUSTED_FIXTURE`.

## Current discovered blocker

The AI-07 parent #990 advanced after #1004's green CI. The original #1004 child base SHA is `d4f034ac6068e5228b3cc192eb6e1a2d02029709`; a later observed parent #990 head is `856eec6e953006ace62d109dd3f3e92599ebe06f`. These are observational and **must be refreshed by the live check**, not relied on as permanent facts.

Reconciliation owner: the coordinator with AI-07, on a separate integration branch; keep both distinct C programs, do not remove /W4 /WX tests, and do not overwrite the active parent. Run new exact-head CI and then the full merge-tree rehearsal once the child is updated. CORE production remains **NO-GO**.
