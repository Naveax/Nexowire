# K08 PR closeout evidence — D-043…D-048 (P007/V006)

Status date: 2026-11-08. This is **three existing PRs**, not a new PR or a
request to merge them. Upstream `main@52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`
is the comparison base. Owner [#1096](https://github.com/Naveax/Nexowire/pull/1096)
owns protected runtime and the required CI workflow; owner
[#1068](https://github.com/Naveax/Nexowire/pull/1068) owns `web/app.js`.

## D-043/D-048: exact diff inventory and non-duplication decision

| Existing PR / exact head | Unique paths/test work | General CI | Ownership and disposition |
| --- | --- | --- | --- |
| [#1035](https://github.com/Naveax/Nexowire/pull/1035) `e0de00624b1de3c0564ebc37e2c50ae914259a4f` | `test/delegated/pool-k08/mcp-response-redaction.test.mjs`, its README; actual `redactDiagnosticValue` synthetic channels, keys, circular data; **5 PASS / 1 TODO** | [41338306321](https://github.com/Naveax/Nexowire/actions/runs/41338306321) `action_required`, **0 jobs** | **Unique** redaction QA, no duplicate file/diff in #1106/#1128. Keep unmerged pending security-owner review of `Cookie`/`Set-Cookie` diagnostics and CI. If consolidating PRs later, transfer this complete test/README unchanged to an existing K08 PR first, then verify the destination and request ŞEF's close decision. Do **not** close now or misreport the TODO as PASS. |
| [#1106](https://github.com/Naveax/Nexowire/pull/1106) `37530c9553d8e6746a0774a5500236ad6c2bc78e` | K08-owned `docs/ARCHITECTURE.md`, `docs/MCP_SURFACE.md`, five unique K08 source QA files and the new cross-surface test | [42485671743](https://github.com/Naveax/Nexowire/actions/runs/42485671743) **7/7 general jobs success** | Keep as distinct MCP/architecture documentation QA. **32/32 local PASS**; required workflow calls only three older K08 tests; newly added nested suites **HOSTED_NOT_RUN**. K13 owns discovery, not K08. |
| [#1128](https://github.com/Naveax/Nexowire/pull/1128) `5f2b654d4c23d55a1ff3dd141f2117cb9e7f0872` | `test/delegated/k08/issue539-status-vocabulary.{json,md,test.mjs}`: six-state Turkish glossary, negative label-collision fixtures and standalone dashboard VM | [42411934421](https://github.com/Naveax/Nexowire/actions/runs/42411934421) **7/7 general jobs success** | No path overlap with #1106; zero-device VM repro overlaps **one behavior**, but six-state glossary and negative scenarios remain **unique**. Keep distinct until owner #1068 applies UI correction or ŞEF explicitly chooses to carry all unique fixtures to #1106. Nested test **HOSTED_NOT_RUN**. |

These PRs cover **different** evidence: redaction of diagnostics (#1035),
runtime/output vocabulary for MCP and Bridge (#1106), and the *actual* Turkish
dashboard render plus translation glossary (#1128). Neither a green generic
workflow nor a locally passing source test is proof that a runtime issue was
corrected. There is no reason to force-merge three open Drafts or discard the
unique fixtures merely to reduce PR count.

## D-044: latest-main relevant source equivalence and offline reruns

For **#1106**, `git diff --name-status origin/main k08/p006-mcp-followup --
src/mcp src/protocol/error-contract-v2.ts src/agent/operation-journal.ts
src/agent/windows-console-grant.ts web/app.js web/connect.js web/admin.js`
returned **no changed paths**. The test-source targets on its older branch
therefore match current `main@52d452f` byte-for-byte in these paths; this is
the only current-main equivalence asserted here. Run:

```bash
node --test --test-reporter=tap test/delegated/k08/*.test.mjs
```

Observed Node v24.22.1 **32/32 PASS, zero FAIL/SKIP/TODO** on #1106's own
branch. This does not mean the docs themselves are merged. `git diff --check`
for K08 docs/tests also PASS. Other paths were not assumed equivalent.

For **#1128**, current main and #1128 match on `web/app.js`, `web/connect.js`
and `src/mcp/**` (the same `git diff --name-status` comparison returned no
changed path); standalone source test **4/4 PASS**, 0 FAIL/SKIP/TODO.

For **#1035**, current main and #1035 match on
`src/mcp/create-server.ts`, `src/protocol/error-contract-v2.ts`; its
standalone source test returned **5 PASS / 1 TODO / 0 FAIL**. TODO is an
unreviewed security-owner boundary, *not* success for `Cookie` values.

## D-045: actual owner #1068 UI contradiction remains RED

The latest queried #1068 `web/app.js` blob is
`ab5b5d186ee6e1e3dab074952ffcadb153d6ef31`, unchanged from the tested
source. With `render({devices:[]})`, the K08 Node VM produces:

- Header pill: **“Bağlı”**.
- Device count: **`0`**.
- Empty card: **“Henüz bağlı cihaz yok…”**.

The desired invariant **“the top badge must describe dashboard loading,
not a device connection when no device exists”** is still **RED against the
current owner source**. The test-local replacement “Kontrol paneli yüklendi”
passes this invariant without editing `web/app.js`. Current #1128 test
**4/4 PASS** means it successfully detects that source contradiction;
the *underlying UI wording bug remains unresolved*, not fixed by K08.
Request owner #1068/K03 to apply a narrow copy change, then rerun #1128's
actual VM on the updated blob and perform real browser acceptance.

## D-046: exact hosted discovery; D-047: physical limitations

- #1035: CI run **41338306321**, `action_required`, **0 jobs**. Not a PASS.
- #1106: CI run **42485671743**, **7/7 general jobs success**, both Node
  22 and 24 `test` jobs include the named K08 legacy step. Required workflow
  explicitly lists only `mcp-doc-contract.test.mjs`,
  `mcp-doc-fences-endpoints.test.mjs`, `mcp-output-language.test.mjs`.
  `issue539-error-provenance.test.mjs`,
  `issue539-mcp-evidence-matrix.test.mjs`,
  `issue539-ui-status-audit.test.mjs`,
  `issue539-cross-surface-status.test.mjs` remain **HOSTED_NOT_RUN**.
- #1128: CI run **42411934421**, **7/7 general jobs success**; its
  `issue539-status-vocabulary.test.mjs` is not explicitly selected by
  the required workflow and is **HOSTED_NOT_RUN**.

K13's auxiliary delegated workflow may run separately selected files, but a
green required run cannot be credited to a nested filename absent from its
execution list. There was **no duplicate CI dispatch** and no alteration to
the protected `.github/workflows/ci.yml`.

Real browser layout/accessibility, original provider refusal, authenticated
Hub, live Agent, Windows local owner consent, installed binary provenance,
signed physical Bridge receipt and independently read-back task outcomes:
**NOT_RUN by K08**. For issue #812, a source status is not physical permission.
For issue #539, neither a simulated `Bağlı` pill nor a generic job PASS is
end-to-end completion. No GitHub issue closure, upstream main merge, production
device or security source modification was attempted; owner authorization
and final acceptance remain with Ömer/ŞEF.
