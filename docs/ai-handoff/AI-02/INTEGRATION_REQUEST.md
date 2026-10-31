# AI-02 | integration requests (source-owner boundaries)

## P0-01: independently authenticated installed Agent identity
`scripts/local-enrollment/install.ps1` validates exact owner account, device ID and installation UUID but currently consumes an operator-provided `AgentIdentityFile`. Arbitrary caller-selected matching JSON is **not** an independent identity proof. Coordinator must define a protected, authenticated installation export and readback (with owner SID, agent binary provenance, device UUID, installation UUID, generation and trusted scope), without allowing `native-agent.ts` edits from AI-02.

## P0-02: named-pipe caller executable identity
The native pipe impersonates a same-owner active console and verifies an independent signed challenge. Same-user untrusted processes may still attempt status calls, relay challenges or exhaust nonce storage. Coordinator must provide a race-safe process/file-ID/publisher/launch-identity boundary and independent native hostile-client tests. No grant or CNG key by itself is a remote dispatch authority.

## P0-03: independent reversible/irreversible revocation custody
The AI-02 local marker and file-sharing fence order native revoke vs attest, but do **not** prevent old protected JSON/key state restoration after rollback nor revoke already issued remote permits. AI-03 must require current independent externally durable grant generation and revocation, mTLS peer binding, one-use challenge and exactly-once CAS. Missing remote freshness remains deny-only.

## P1-04: real Windows SCM/IPC/installer/recovery test facility
Provide approved, disposable Windows environment for service start/stop/crash/reboot, actual active console session/user consent, changed SID/session, hostile pipe peer, ACL/key checks, interrupted install/rollback and offline revoke. The CI `--self-test` diagnostics are not a substitute for physical owner acceptance; do not target Naveax or Work-PC without separate authorization.

## P1-05: operational error reporting
The pipe returns bounded generic denials without leaking keys or SID, while timeout/disconnect can close the pipe without a response. Coordinator should define protected redacted log/incident instrumentation before integration; do not expose enrollment secret or user telemetry in logs.

**Ownership:** AI-02 `native/windows-local-enrollment/**`, `scripts/local-enrollment/**`, v2 protocol/test and own handoff only; AI-03 verifier/mTLS, coordinator shared Agent/CI/release, AI-08 independent QA. Never change somebody else's files. CORE remains disabled.
