# Scale v2 | HARD CONSTRAINT: $0 operator cloud bill, local-first tool execution

**2026-10-15 owner clarification | supersedes the Paid-cloud-as-default interpretation in HyperScale ADR.** Scope is S1–S5 foundation, no S6 implementation and **NO live cutover**. Goal: maximum sustainable hosted MCP throughput with **zero new operator cloud invoices**, utilizing each user's existing PC/Internet and an existing, explicitly owned always-on host only where strictly needed. Local electricity, ISP, purchased domains and platform access are **not inherently free**; prove them separately. Do not silently sign up for metered infrastructure or require the end user to configure networking manually.

## Decisive architectural change

**Local-first, not “Cloudflare Worker per tool”.** Keep the existing Nexowire Agent and Hub protocol compatible. Per user's existing PC:
- local MCP request handler / permission-and-device authority (if the chosen ChatGPT connection permits the required remote MCP flow);
- agent tool executor, local task queue and bounded concurrency, filesystem/OS and screen access; local SQLite state, dedupe and logs, encrypted secrets;
- owner-scoped OAuth credentials and short-lived authorization only when backed by a trustworthy authentication authority.

A transport connecting ChatGPT's *remote* MCP endpoint to that local server is still mandatory. Choose the cheapest supported authenticated link. Supported options to **verify** in an opt-in lab:
- **Named Cloudflare Tunnel (HTTP origin)** from user's PC or an existing self-hosted relay over outbound-only `cloudflared`. A tunnel can proxy directly to a local origin *without an application Worker/D1 on each request*. This **does not** mean unlimited free throughput or unrestricted service terms; prove named tunnel, DNS hostname, connection, usage/egress policies and stable HTTPS endpoint. `trycloudflare.com` **Quick Tunnel is DEV ONLY**, no uptime SLA, 200 concurrent proxied requests and no SSE. Never ship it as production MCP.
- **OpenAI Secure MCP Tunnel** only where the user's ChatGPT account/workspace actually supports it; current OpenAI documentation states ChatGPT cannot directly connect to localhost. Confirm whether the official connection/URL and tool permissions can be provisioned through Nexowire's one-click onboarding without additional customer plans.
- **Owner's EXISTING self-hosted HTTPS Hub**, connected over a Cloudflare Tunnel to existing machine. Central Hub should be a thin routing/auth/quota service, NOT a paid per-request cloud Worker; this remains a single shared machine/network bottleneck and outages affect all users. It is a migration bridge, not unlimited scale.

If stable per-user hostnames and one-click MCP registration cannot be achieved without paid infrastructure, explicitly mark that onboarding variant NOT FEASIBLE within the $0 operator-cloud-bill objective. Do not hide the cost in the end user's subscription.

## Hardest problem: trusted 1k/day quota without per-call SaaS spend

One user must not be able to raise plan limit by editing their own PC. Local SQLite limits are honest-client safety, NOT adversary-resistant subscription enforcement. User owns the machine and can modify processes/database/clock; a signed offline quota lease that the same local machine verifies **still cannot prevent a modified Agent from bypassing it**.

Choose **one** security contract before implementation:
1. **Central trusted self-hosted admission every hosted call.** The existing always-on owner-managed Hub verifies authenticated account/client/tool, current plan/version/UTC day, canonical invocation digest, quota reservation and replay before forwarding. It uses owner's existing machine/network, not billed Worker/D1; user PC executes the tool. Throughput and operator ISP limits must be measured, and the Hub must never expose its dashboard/Agent token to the user. Highest confidence quota, but a central capacity ceiling remains.
2. **Batch-signed tickets with trusted admission at a gateway.** The central trusted owner-managed Hub reserves a fixed, conservatively bounded block of authorizations for a given account/day/epoch; an independently trusted ingress validator consumes each ticket once and executes only on successful consumption. Splitting task execution across user PCs reduces hosted CPU but does not eliminate the trusted admission/ledger work. Revocation, clock-skew, return of unused tickets and unknown state require explicit negative tests.
3. **Pure per-user direct MCP tunnel without central admission** is suitable ONLY for a deliberately **unmetered self-hosted/personal mode** where a user accepts local policy and their own device/ISP costs. It cannot enforce commercial cross-device 1,000/day SaaS entitlements against a malicious owner and should not falsely claim otherwise.

For the user's stated **Free 1,000 tool calls/day with only call cap changing on plan switch**, the simplest rigorous first release is option **1** with the trusted coordinator self-hosted on already owned hardware; preserve owner/device authorization independently of commercial tier. Any central gateway in the path still handles **one authenticated admission per hosted tool**, regardless of where CPU work runs.

## User PC practical limits (do not confuse with 10M/day ingress)

- 1,000/day is ~0.012 calls/second per user on average.
- 10M/day is ~116 calls/second average; with 10x peaks ~1,158 calls/second. It is a **load target**, not a validated single-PC promise. PC UI automation, serial mouse focus, shell mutations and slow disk/network tools cannot be parallelized like tiny CPU calculations.
- A single serialized 100-ms tool runs at most 10/sec, only 864,000/day even before network delays. An 8-core ideal CPU workload of 100 ms/call yields an unrealistic upper bound of 80/sec (6.9M/day); real usable throughput will be lower after OS overhead. For 10M/day on eight fully saturated cores, average CPU time must be under ~69 ms per call even ignoring all other costs. 10x bursts demand queue/backpressure.
- Batching many safe, owner-authorized LOCAL operations behind one externally authenticated MCP call may reduce billed hosted tool calls, but **must** count the externally exposed call under quota, log/audit child operations, bound fan-out, and not serve as a hidden bypass of commercial limits.

## Reference sources (verify before rollout)

- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt (remote MCP and supported Secure MCP Tunnel)
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/ (outbound named tunnel and published origin)
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ (Quick Tunnel dev-only 200 concurrent and no SSE)
- https://developers.cloudflare.com/workers/platform/limits/ (100k/day Workers Free, not a tunnel origin's application meter)
- https://developers.cloudflare.com/d1/platform/pricing/ (Free D1 daily row limits)
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/ (published app, Access policy)

## Safest engineering order

- **Z0: read-only cost/ingress inventory:** detect which deployed MCP requests really invoke Workers/D1; do not assume a proxied Cloudflare Tunnel alone has the same Worker meter.
- **Z1: local MCP loopback prototype:** reuse current Agent without a second Agent process; local SQLite, replay, connection reuse, scoped tool registry and no change to desktop interaction.
- **Z2: zero-metered-cloud transport trial:** isolated dummy Agent account and a stable, authenticated named tunnel or available Secure MCP Tunnel; test endpoint security, resume, SSE/streamability, cancellation, latency, domain and provider terms. Do not test against existing user's active Agent route by default.
- **Z3: central self-hosted quota authority:** enforce canonical Free 1000/day (only after a separately authorized migration from existing 1000 weighted/month), plan version / UTC reset / owner-device revocation / no forged plan, tamper-resistant remote metering.
- **Z4: measured load:** 1k/10k/100k logical calls/day progressively on allowed *test machine* with CPU/IO/network/p95, resource caps and safe no-foreground-impact execution. Only promise 10M after actual sustained proof on hardware and validated platform admission.
- **Z5: rollback + release:** cost must remain $0 in third-party cloud billing, automatic stop before any metered service provisioning, exact-head CI, owner-approved canary and user-visible failure/retry recovery.

**Hard stop:** do not automatically enable Workers Paid, D1 Paid, metered relays, hosted model inference or upstream API calls in pursuit of throughput. Cloudflare subscription/account request quotas apply; do NOT circumvent them with account splitting. Current roadmap PRs #507/#508 do not implement or deploy a local-first route.
