# AI-05 Test evidence (2026-10-31)

- Repository: Naveax/Nexowire
- Base SHA: `7e4093c30c1ead3cd22888184450c34aef4737da` (#980)
- Initial source+test commit SHA: `c6957704e02e5150414e66f727625cf31f8d99c1`
- Initial GitHub CI run ID: `41196039175`, observed in_progress when this document was authored.
- Final PR SHA: read from live PR #992 after all documentation commits.
- Test host: NOT executed locally (this agent's isolated runtime cannot clone GitHub, DNS unavailable).
- Requested local commands: `node --test --import tsx test/ai05-cas-scope-snapshot.test.ts`; `node --test --import tsx test/agent-remote-cas.test.ts`; `node --test --import tsx test/core-windows-mutation-dispatch.test.ts`; `node --test --import tsx test/qa-fence-request-mutation-p11.test.ts`; `npm run typecheck`; `npm run build`.
- Local exit codes: NOT RUN / NOT VERIFIED. No PASS claim.
- Newly added test cases: 4 source/synthetic cases (owner/session/UUID mutation, getter denial, lost ACK no retry, already-reserved UUID no insert). CI result pending.
- No real PostgreSQL hosting provenance, protected OS identity, Windows Broker, physical UAC/ACL, workstation or live Agent mutation tests performed. Do not label source CI as physical acceptance.
- Existing upstream #980 CI 41113730982 was reported 7/7 success on its own exact SHA; it does not certify this new head.
