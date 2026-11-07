# #780 / #539 R17 — K17 current-main skill catalogue review

Snapshot: `Naveax/Nexowire main` `4e7db16f4233048a956664bef6b607781eb63fb7`, checked 2026-11-07. This is a **read-only metadata/path inventory**, not a runtime sandbox claim.

## PR overlap and issue boundary (T-351, T-355, T-356)

- [#1030](https://github.com/Naveax/Nexowire/pull/1030) is still an open Draft at `bc97cd84c7b224cdfe140a77a7f9200d6bcf50e4`. Its six files (`src/skills/manifest.ts`, `src/skills/registry.ts`, and four `test/delegated/k17/*` reports/tests) are **not in current main**. The relevant main source blob IDs remain `manifest.ts` `83e30bbd16fb30d53bddaa5e916da16ac20a31d0` and `registry.ts` `77d6a74bf715093b54f467cb4367d66c692f07a2` from the earlier base. The diff of main `93b6df3...` to `4e7db16...` contains no `src/skills` or shipped-skill test changes. Do not duplicate the parser duplicate-key implementation or registry case-fold ordering proposed in #1030.
- #1030's exact-HEAD upstream CI run `41338216468` concluded `action_required`; no successful job evidence was observed. Local test reports in the PR are not an upstream CI gate.
- The #1030 tests already cover duplicate fields, directory/H1 mismatch, capability interpretation and a deliberately unresolved direct-`SkillRegistry.load()` symlink escape TODO. These are not repeated as a proposed runtime source fix in this branch. In particular, the direct-load escape is a path-trust concern requiring authorized runtime/security-owner review.
- [#1080](https://github.com/Naveax/Nexowire/pull/1080) remains an open Draft at `94fb38e4b090e182b35c7e6cf54e578497871d69`. Its 13 changed paths concern Git metadata, sandbox and owner tests; none are `src/skills/**` or `test/delegated/k17/**`. This branch does not modify or assert #1080's protected sandbox behaviour.
- This follow-up adds an independent, read-only catalogue walk and a conservative description support-claim check. It changes **only** `test/delegated/k17/**`, so it cannot broaden capability, privilege or sandbox admission.

## Actual findings and limits (T-352–T-354)

- Forty-five shipped skill directories were checked using `lstat`; no symlink entry, symlink manifest, missing manifest, directory/name mismatch or contradictory **explicit** platform support phrase was found in this snapshot.
- Missing/blank `platforms` is reported as **UNKNOWN** in the audit, even though the legacy runtime parser defaults omitted platforms to `any`. The scanner deliberately does not change runtime admission semantics.
- Negative fixture tests cover a `Runs on Windows` claim with a Linux-only manifest, a mere mention of Windows logs (not a support promise), duplicate frontmatter, symlinked directory, symlinked manifest file and missing manifest.
- The scanner recognizes only narrow explicit English support phrases; it is not exhaustive natural-language or platform QA. It never follows symlink targets, starts an agent, contacts live services or proves real Windows/device support.

## Reproduce

```sh
node --import tsx test/delegated/k17/issue780-catalog-audit.test.ts
npm run typecheck
npm run build
```

The suite lives in a nested delegated folder; the default `npm test` Bash glob may not discover it. CI job results, physical OS tests and deployed-device acceptance must be recorded separately as NOT_RUN until observed.
