# K13 P009 — exact CI evidence and owner integration handoff

Issues: #1006 (CI discovery / evidence), #539 R22 (false-green acceptance).
Current main baseline for this comparison:
`52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`.

## Already proven, not yet merged

- K13 consolidated Draft PR #1149, previous source HEAD
  `b6b5e60ba93f1a40fab432fedc06d334971a6c37`: upstream required
  [CI run 42514702344](https://github.com/Naveax/Nexowire/actions/runs/42514702344)
  `completed/success`, **seven real jobs successful**. This is a verified
  generic CI result for that source SHA, **not** proof the seven omitted
  delegated tests were called by required CI.
- The same previous source HEAD has fork
  [auxiliary run 42514696323](https://github.com/SinsiVinci/Nexowire-fork/actions/runs/42514696323),
  4/4 jobs successful; Node 22 and 24 each execute 24/24 K13 evidence tests
  and 33/33 explicit seven-path delegated assertions. The historical pinned
  #1112 jobs each execute 11/11 regressions, but are AUXILIARY_ONLY.
- Owner Draft #1096 currently uses source HEAD
  `43e8125e7a4ced654a769b661dc10938c02bc7a4` and 
  [CI run 42517451677](https://github.com/Naveax/Nexowire/actions/runs/42517451677)
  `completed/success`. Both Node22 job 128843471243 and Node24 job
  128843471159 **explicitly invoke three K11 test files** in the isolated
  S5 step; each TAP **70/70**, fail/skip/todo zero, dynamic TAP gate accepted.
  This run had **nine successful jobs and three skipped jobs**, so it does not
  attest the skipped jobs or physical acceptance.

## The remaining required discovery gap

The `main` workflow has **55** delegated test files: 43 explicitly mentioned
through source calls/wildcards, five reachable with its single-directory npm
glob, and **seven without a known callsite**. Owner #1096's unmerged branch
adds explicit invocation of exactly these three formerly omitted files:

1. `test/delegated/k11/issue-487-commercial-unknown.test.ts`
2. `test/delegated/k11/issue-487-meter-acceptance.test.ts`
3. `test/delegated/k11/p005-s5-evidence.test.ts`

The following **four** have no known explicit callsite in either main or
owner #1096's current workflow source:

1. `test/delegated/k09/roadmap-evidence.test.mjs`
2. `test/delegated/k16/environment-doctor-contract.test.ts`
3. `test/delegated/pool-k17/markdown-anchors.test.ts`
4. `test/delegated/pool-k19/audit-physical-pass-labels.test.ts`

Owner may invoke these as an explicit Node22/24 offline test group or add a
demonstrably equivalent discovery mechanism. Because the protected
`.github/workflows/ci.yml` belongs to #1096, no K13 code alters it.
Until owner work lands on `main` and these paths are observed in required
CI output, report **REQUIRED_EXECUTION_NOT_PROVEN**; do not promote fork
auxiliary or a successful generic workflow run to source test acceptance.

## Regression found and corrected in existing #1149

`classifyHostedEvidence` previously accepted a filename list borrowed from a
fork auxiliary run as evidence for *different* required jobs. A negative test
demonstrated `HOSTED_EXECUTED` when `observedFileProofs.run_id` did not match
the required run. The narrowed gate now demands a binding for every selected
file to the exact workflow run ID, real job ID, checked-out source SHA and
passing test result; for required CI, **both** Node22 and Node24 jobs need
their own matching file proof. Generic job success with unbound filename
mentions stays `NOT_PROVEN`.

This regression is a synthetic evidence-gate test; it does **not** claim
that upstream CI ran the four outstanding files. Physical Windows user PC,
two-PC, real provider, release acceptance **NOT_RUN**. Merge/issue closure
require explicit owner approval. The old #1134 workflow version overlaps
the canonical #1149 path; preserve unique tests and handle disposition
without merging two contradictory versions.
