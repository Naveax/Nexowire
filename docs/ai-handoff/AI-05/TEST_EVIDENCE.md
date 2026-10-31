# AI-05 Test evidence (2026-10-31)

- Repository: Naveax/Nexowire
- Base SHA: `7e4093c30c1ead3cd22888184450c34aef4737da` (#980)
- Initial source+test commit SHA: `c6957704e02e5150414e66f727625cf31f8d99c1`
- Initial GitHub CI run ID `41196039175`: FAILURE (TypeScript TS2345 in Reflect.ownKeys candidate). Source compiler narrowing fixed at `925c18fd1bbb116da26e783d85e3e42710cb1dc2`. Additional receipt snapshot and cases in `43ca9f50fe76b4595e046b0dd49d339c82505696`; this code SHA's CI 41196350584 was pending when reviewed. No earlier green run transfers to the eventual final HEAD.
- Final PR SHA: read from live PR #992 after all documentation commits.
- Test host: NOT executed locally (this agent's isolated runtime cannot clone GitHub, DNS unavailable).
- Requested local commands: `node --test --import tsx test/ai05-cas-scope-snapshot.test.ts`; `node --test --import tsx test/agent-remote-cas.test.ts`; `node --test --import tsx test/core-windows-mutation-dispatch.test.ts`; `node --test --import tsx test/qa-fence-request-mutation-p11.test.ts`; `npm run typecheck`; `npm run build`.
- Local exit codes: NOT RUN / NOT VERIFIED. No PASS claim.
- Newly added test cases: 6 source/synthetic cases (owner/session/UUID mutation, identity getter denial, lost ACK no retry, already-reserved UUID no insert, receipt created/sequence mutation after validation, receipt getter denial). Latest final-head CI result pending; not marked PASS.
- No real PostgreSQL hosting provenance, protected OS identity, Windows Broker, physical UAC/ACL, workstation or live Agent mutation tests performed. Do not label source CI as physical acceptance.
- Existing upstream #980 CI 41113730982 was reported 7/7 success on its own exact SHA; it does not certify this new head.

## Additional adversarial source tests
The source/test child `caadd1db53fb4993402a0abd06f3b8f2abb7c883` adds two cases: malicious request getter never invoked and polluted/prototype/symbol request denied. The latest patch also adds a ninth synthetic case: hidden non-enumerable authorization fields on request, authenticated scope and external receipt denied before mutation. The exact final-head CI must be checked separately; do not reuse run 41197201487 from the pre-handoff source SHA.

## HTTPS post-dispatch uncertainty regression
Added `test/ai05-cas-http-outcome.test.ts` with 2 deterministic tests: synthetic HTTP 408, 425, 429, 500, 503, 504 returned for reserve/revoke/re-pair (18 distinct requests, no internal retry; all denied as UNKNOWN) and explicit 403/409 responses (6 distinct requests, denied as refusal). Source-only fake fetch responses, not a real remote CAS service. CI exit codes for the new SHA are PENDING and must not inherit previous 9-case SHA results.
