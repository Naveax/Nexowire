# AI-05 source candidate handoff (provisional)

- Status: NO_GO for production; IN_PROGRESS for source review/CI
- Branch: `ai/05-cas-executor`
- Draft PR: https://github.com/Naveax/Nexowire/pull/992
- Base: `integration/core-after-v108-20261030`
- Base SHA: `7e4093c30c1ead3cd22888184450c34aef4737da`
- Source+test SHA: `c6957704e02e5150414e66f727625cf31f8d99c1`
- Exact final HEAD: see live PR metadata; this report cannot self-embed the SHA of the commit that contains itself.
- Modified owner files: `src/agent/postgres-bound-grant-cas.ts`, `test/ai05-cas-scope-snapshot.test.ts`, this `docs/ai-handoff/AI-05/**` directory.
- Test execution: 4 adversarial source cases added; current-head CI/exit codes must be recorded from the actual run. Local execution not possible in isolated runtime (DNS).
- Mock/real OS: only source-level synthetic fixtures; no live independent PostgreSQL or Windows physical acceptance.
- Remaining P0 gates: protected Broker admission and receipts, external CAS hosting/restore custody, native Windows identity/ACL trust, sandbox worker, real two-device enrollment/revoke/restart.
- Guardrail: `CORE_EXECUTOR_DISPATCH_ENABLED=false`; no merge, deploy, UAC, ACL, local enrollment or production mutation.
- Coordinator handoff: review PR #992 and integration requests; merge/release decision stays with coordinator.
