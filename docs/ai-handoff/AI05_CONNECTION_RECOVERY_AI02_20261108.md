# AI-05 Connection v2 recovery and AI-02 pre-login integration contract

**Candidate base:** PR #1096 at `43e8125e7a4ced654a769b661dc10938c02bc7a4`
**Work branch:** `agent/ai05-connection-recovery`
**Owner:** AI-05 (network transport and Cloudflare only)
**Status:** SOURCE QA PASS, PHYSICAL EXTERNAL/REBOOT QA NOT RUN. No production deployment.

## Existing transport contracts to preserve

1. The local Hub is reachable independently of Cloudflare via `ws://127.0.0.1:43110/agent` and HTTP `127.0.0.1:43110`. The native Agent defaults to this endpoint when no other WebSocket endpoints are configured. User-configured endpoint order is not silently rewritten.
2. `src/agent/windows-prelogin-bootstrap.ts` explicitly requires the SYSTEM pre-login Agent to use **only** `NEXOWIRE_HUB_WS_URL=ws://127.0.0.1:43110/agent`. It rejects `NEXOWIRE_HUB_WS_URLS` and reads a LocalMachine-DPAPI token from `C:\ProgramData\Nexowire\system-agent`. AI-05 does not change this boot policy.
3. Remote/public Agent ingress is opt-in and must be admitted by the Hub's strict bound owner/device/epoch/lease authorization, never by the public bridge alone. A WebSocket HTTP 101, process `Running`, or OAuth metadata `200` does **not** imply an authenticated tool session.
4. `AgentBroker` has one active connection per device ID and fences stale socket responses. Remote read-only requests require fresh authorization after reconnect. Pending mutating requests become `MUTATION_STATE_UNKNOWN` (or the existing instance-change rejection), never automatic re-dispatch. Read-only local retries remain bounded by the existing broker policy.
5. Transport failures (TCP/DNS/5xx and 1006/1011) use capped backoff and endpoint rotation. An accepted TCP connection which never produces WebSocket HTTP 101 now has an explicit 10-second handshake deadline; a timed-out peer cannot block trying the next configured endpoint forever. Credentials rejected by 401/403, disallowed 4xx, policy close 1008, and invalid certificates are fatal until authorization/configuration is repaired.

## AI-05 change

The `local-first cloudflare-run` foreground process now supervises a **previously admitted** cloudflared child after an unexpected exit. It closes the prior loopback origin, reopens the original selected profile, revalidates binary/credential custody and local Hub admission, and retries with bounded jittered backoff (1, 2, 4, 8, 16, 30 seconds before jitter; maximum 30 seconds). A connector surviving at least 10 seconds resets the backoff. A SIGINT/SIGTERM aborts the pending retry. Preflight/credential/runtime cleanup failure is **fatal**, not downgraded to transient.

This is not a public availability or DNS assertion. The scheduler has only three task-level restarts; the new *in-process* supervisor handles a recoverable child exit without consuming those attempts. It never writes Cloudflare tunnel IDs, credentials, device enrollment, or Hub/Agent tasks.

## Contract required from AI-02

- Depend on the AI-01 verified SYSTEM Hub startup before launching the SYSTEM pre-login Agent; do not add Cloudflare dependency at boot.
- Use the machine-owned immutable identity and machine-scoped token only for the SYSTEM pre-login Agent. Keep interactive owner credentials and identities outside pre-login context.
- Preserve the protocol hello device binding and a fresh `instanceId` for a newly started process. Define and validate the SYSTEM-to-interactive identity handoff: if the same logical device ID is used, the broker replaces the old socket; if a distinct ID is used, AI-02 must explicitly prevent duplicate visible logical devices during handoff.
- Only publish pre-login machine-status capabilities. A pre-login socket must not gain interactive capabilities or elevated mutation authority through a reconnect.
- Include a physical disposable-VM acceptance sequence: no sign-in to SYSTEM Hub connection, owner login handoff, network outage, Hub restart, old socket ACK fencing, wrong-device credential refusal, and no replay of one ambiguous mutation request. A reboot test not actually executed is `NOT_RUN`, never PASS.
- Surface transport status as authenticated/unknown/disconnected, not merely scheduler task `Running`. Do not elevate Cloudflare OAuth/public-readiness statuses from local health alone.

## Evidence on Work-PC (2026-11-08)

- Read-only live local Hub probe `HEAD http://127.0.0.1:43110/health`: HTTP 200.
- No installed task matching the Cloudflare/Connection task filter was found. **Live Cloudflare cutover and public WSS acceptance not exercised**.
- Existing Windows local connection/restart regression: 32 PASS, 0 FAIL, 4 SKIP.
- New Cloudflare reconnection supervisor and adjacent Cloudflare suite: 25 PASS, 0 FAIL, 4 SKIP (includes 7 new deterministic tests; suites overlap with the prior group).
- Agent silent-handshake deadline, endpoint priority, v2-07 no-replay and Cloudflare supervisor focused suite: 25/25 PASS (includes 2 new deadline tests and an actual local TCP peer withholding HTTP 101).
- Remote authorization, Cloudflare external origin, DNS/TLS/redirect, and fault-proxy tests: 88 PASS, 0 FAIL.
- `npm run typecheck` and `npm run build`: PASS.
- NOT RUN: reboot/power loss, actual WAN interruption, live named tunnel, real external origin cutover, official signed rollout, multi-hour soak, or pre-login user handoff.

**Release status: NO-GO** pending platform acceptance and upstream integration. This branch is a source change only, not a change to the live Work-PC or NAVEAX installation.
