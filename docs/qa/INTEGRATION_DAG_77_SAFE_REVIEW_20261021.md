# P0 #24 — 77-PR exact-HEAD DAG, risk and conditional merge review

**Observation:** 2026-10-21, GitHub `Naveax/Nexowire`; **DRAFT / SOURCE-ONLY / PRODUCTION NO-GO**. Neither this report nor a passing workflow authorizes a P0 merge. No Agent, Broker, ACL, UAC, VM, live CAS or `ReVoltVPN-Ubuntu-Lab` was touched.

## Provenance and limits

- GitHub `main` verified at `754cc4364822be5fda528f54042fb22a84f19924`. `#630` independently confirmed **merged**; excluded from open DAG.
- **77 OPEN PRs**: a new `search_prs is:open` enumeration, 77 individual `get_pr_info` exact head/base refs, 77 `fetch_commit_workflow_runs(commit_sha=HEAD)` primary CI queries, and targeted changed-files and merge-base inspections.
- Machine-readable file: `docs/qa/p0-integration-dag-open77-20261021.json`: **49 parent edges**, **44 CI SUCCESS / 33 CI FAILURE** at the queried SHAs. This is a timestamped, **frozen** evidence set. Previous 38/50/67-PR JSON files remain historical, not current. When any HEAD, CI status, base or open set changes, every downstream green assertion must be recomputed.
- **49/77 comparison entries** are pinned, but only the ten new #667–#676 entries were independently refreshed this iteration; older comparisons remain historical and require live requery before merge. Two old entries for moved #642 and #664 were invalidated, not recycled.
- **41/77 PRs** have complete changed-file claims. The other 36 have historical *sampled* paths. Thus the observed owner collision list is a lower bound; **no global collision-free result** can be claimed. The existing `scripts/qa24-live-dag.ts` read-only live collector can query *all* open PR pages/files and exact GitHub compare data, then double-read main/open refs to reject collection-time races. It requires an authorized read-only GitHub token.
- Source SHA-specific CI lookups do not prove Windows HIGH/SYSTEM token, signed publisher, immutable imports/updater/parent ACL, one-time local UAC, real off-host CAS or production revocation.

## Exact Windows failure for #664

#664 `60ece49f695a57c1d1d09f87b12c322c80d45b2f`, GitHub CI run [39632679723](https://github.com/Naveax/Nexowire/actions/runs/39632679723): overall **FAILURE**. Node 22, Node 24, macOS, Linux, WSL2 and security jobs succeeded. Windows `browser-live` job `119334841721` failed the existing `Windows Job fast-exit stdout and stderr are drained before exited status` assertion, `test/windows-job-owner.test.ts:216`, **iteration 10**, reporting `exited` before `stdout` capture. This is a real hosted failure. It is **not evidence that #24's docs/tests caused the Windows Job defect**. No owner implementation was edited, no red test disabled, no duplicate run queued. Coordinate Windows Job #03 and QA #19 owners.

## DAG blockers

| Chain | Evidence | Required decision |
|---|---|---|
| #620 → #633 → #670 | #670 exact CI PASS; #620 CI FAIL | #03 must reconcile inherited Windows trust/native provider and signed import/ACL proof before integrator review |
| #574 → #621 → #669 | #669 exact CI PASS; #574 CI FAIL | #04 must reconcile ROOT/CORE grant/UI truth and recheck Windows CI |
| #551 → #632 → #672 | Source CI PASS across chain, #551 not based on latest main | #12 signed publisher/import/updater/DPAPI bootstrap proof; separate real Windows enrollment acceptance |
| #582 → #607 → #614 → #631 → #676 | #676 CI PASS, #582 CI FAIL and no real external witness acceptance | #01 durable independent CAS rollback / revoke / re-pair physical proof; no local-only PASS substitution |
| #596 → #616 → #634 → #667 | #667 CI FAIL; #634 FAIL | #08 must repair native-write cancellation semantics and retain UNKNOWN/no-replay |
| #598 → #674 | #674 CI FAIL; parent #598 FAIL | parser and Windows inherited job evidence remain red |
| #618 → #622 → #629 | #622 BASE SHA stale vs current #618; #629 CI FAIL | re-author or reconcile child on current exact parent without skipping negative QA |
| #576 → #609 | #609 BASE SHA stale vs current #576 | independent QA needs fresh exact parent and Windows Job source |
| #572, #575, #642, #664 | moved HEADs against previous snapshot | do not carry forward any prior CI or merge-base result |

**Owner collision (sampled minimum):** 18 independent-branch file overlaps observed. The #576 / #629 / #633 windows helper and ProcessManager changes overlap across `native/windows-job-owner.c`, `src/agent/process-manager.ts`, `src/agent/windows-job-owner.ts`, and `.github/workflows/ci.yml`. #572, #663, #670 also overlap workflow paths in independent branch lineages. Same-file overlap requires owner review, not automatic application; ancestry-shared files are excluded from collision warnings.

## Actionable source-only merge *review* list (NOT merge authorization)

These are **conditional review candidates**, not proof of globally safe merging. Their currently queried CI is SUCCESS, main base matches the queried main, and their observed changed paths are docs/tests or isolated QA workflows:

1. **#648**, HEAD `9d9d11b9326df49d4d1288b24c823f15367bf3eb`, CI `39628249630` SUCCESS. Isolated QA29 audit source workflow/docs/test. #00 may ask QA owner to refresh the full diff, branch protection, approval and global file collision evidence.
2. **#657**, HEAD `561af65b6cc1659f413bf11918b4ff356738c960`, CI `39630539339` SUCCESS. Isolated W26 native-handle **test/docs-only** evidence. Same prerequisites.

Neither is automatically approved. #662 is a stacked QA candidate dependent on #648 and must be reviewed separately after parent acceptance. #671 and #675 are green main-based **implementation PRs**, not test-only candidates. #669/#670/#672/#676 are green children with inherited production blockers. **There is currently no verified production P0 merge-safe list.**

Run the deterministic source review rules:
```sh
npm ci
node --test --import tsx test/qa-24-safe-merge-review.test.ts
node --import tsx scripts/qa24-safe-merge-review.ts > qa24-review.json
# Intentionally exits 2: evidence cannot become a merge authorization.
```
To refresh live (read-only, authorized GH_TOKEN required):
```sh
node --import tsx scripts/qa24-live-dag.ts --repo Naveax/Nexowire \
  docs/qa/p0-integration-dag-open67-20261021.json > qa24-fresh.json
```
Historical inputs are intentionally expected to produce stale-snapshot findings. No tool auto merges, clicks UAC, reruns queued CI or touches a running Agent/VM.

## #00 integrator merge checklist

Re-enumerate all open PRs after this child is created (count immediately grows), require matching current HEAD and exact primary CI run, full diff/owner approval, fresh base...head merge-base and complete file list, no unrelated owner collisions, a conflict-free isolated integration rehearsal and branch-protection approval. P0 native/high-token/remote CAS functionality remains **PHYSICAL BLOCKED** until independently attested. Only then may #00 consider a reviewed, manually authorized change; this QA worker issues no release permission.
