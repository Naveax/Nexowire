# AI-04 Round 2 → AI-05: exact-source Windows mutation admission patch handoff

**Status:** SOURCE-ONLY / PRODUCTION NO-GO. Independent AI-04 contract tests are not native security proof. Never install, deploy, enable CORE, weaken negative tests or repeat the same active CI SHA.

## Exact source and current findings

- AI-04 #1087 source at \`1173227a70fb828149798fb2e57c425ab37062a7\` before Round 2 changes.
- AI-03 #1088 @ \`3eb1b921eed9344b5e2628e39982f2a686c55cdc\`: \`authorizationEpoch\` is a **positive monotonic integer** from D1, \`leaseExpiresAtMs\` is server time + **30 seconds**; SAFE/rotation/revoke invalidates. Migration 0022 follows protected CORE 0020/0021. Live deployment not proven.
- AI-05 #1089 @ \`37fc9163e2b7ccd93600ee23b63f19d4e44ddb77\`: \`src/mcp/http.ts\` still has \`timer.unref?.()\`; \`src/core/agent-broker.ts\` still uses Boolean reauthorization then unguarded \`sendPending()\`; \`native-agent.ts\` already performs *separate* \`remoteCas.reserve()\`, \`operationJournal.begin()\`, \`markDispatched()\` and \`executeCapability()\`, but that does **not** consume an authenticated Hub dispatch reservation.
- AI-04 original Windows run \`42108578552\`: Node24 SUCCESS; Node22 job \`127529847348\` failed with 48 PASS/0 assertion FAIL/1 CANCELLED. Cancelled \`V2-03 bound verifier times out unresponsive authority and never retries automatically\`; \`Promise resolution is still pending but the event loop has already resolved\`. Do not call green combined Windows acceptance.

## A. Minimal exact #1089 source patch (AI-05 owns write)

Apply \`docs/ai-handoff/patches/AI04_AI05_HTTP_NODE22_TIMEOUT.patch\` to #1089 **only after checking its new HEAD**. It removes one \`timer.unref?.()\` and keeps the existing referenced timeout until the awaited Promise.race resolves. The existing \`finally\` clears the timer and aborts pending verifier; the existing terminal \`invalidated\` flag forbids late upgrade.

Do not add an artificial sleep/keepalive or skip the current V2-03 timeout test. Test with Windows Node 22 and 24 using:
\`\`\`powershell
node --test --import tsx --test-concurrency=1 test/v2-03-mandatory-remote-authorization.test.ts
node --test --import tsx --test-concurrency=1 test/ai04/atomic-mutation-authority.test.ts
\`\`\`
The second test is available after AI-05 integrates the source files from #1087. Validate exact SHA and retain full test matrix.

## B. Integrate the Broker mutation entry point (owner: AI-05)

The existing V2-03 path in \`src/hub/agent-websocket.ts\` supplies a \`() => Promise<boolean>\` to \`broker.register()\`. Keep this **for read-only permission**, but do **not** reuse Boolean \`true\` for mutation effect permission. For remote-only sessions add a trusted **socket-bound** \`AtomicMutationCoordinator\` created by AI-05 from a pinned authority \`authorityId\`, AI-03's exact \`ownerId/deviceId/authorizationEpoch/leaseExpiresAtMs\`, a fresh per-call Control Plane verifier and the independently protected CAS authority. Do not construct it from user-visible request input.

At \`src/core/agent-broker.ts\`, on the mutating branch of \`request()\` after strict session validation, build exact wire bytes **once**:
\`\`\`ts
const wire = Object.freeze({
  requestId,
  capability,
  frame: JSON.stringify({type:'request',requestId,capability,input,accessMode}),
});
\`\`\`
The trusted socket-bound coordinator must call \`dispatch(wire, (exactFrame) => connection.socket.send(exactFrame))\` under the **external** authority's \`dispatchIfCurrent\` fence. The branch must:
- Require the coordinator. Missing/wrong owner/device or absent verifier is a **zero-frame** denial, including strict remote reads under the existing Boolean gate.
- Bind to \`connection.instanceId\` and \`this.agents.get(deviceId) === connection\` again at the dispatch callback. This synchronous check may deny socket replacement but **cannot substitute for an external atomic revoke fence**.
- Insert a pending request only when the monotonic CAS reservation is confirmed and do not route a remote mutation into the old unguarded \`sendPending\` path. Reuse existing response/timeout handling for observing a potential ACK; any post-reservation socket/ACK failure must remain \`MUTATION_STATE_UNKNOWN\`.
- The authority must preserve tombstones across reconnect/process restarts. \`pending.has(requestId)\` is an in-memory optimization, **not** idempotency.
- Require *one semantic effect reservation* before a cloned workflow/runbook may mint a new UUID for the same uncertain OS side effect (existing CLEAN-10). Keep read-only reconnect behavior separately tested.

**Important:** A generic remote \`dispatchIfCurrent(reservation, enqueueFrame)\` is an interface contract, not an implementable distributed transaction merely because both methods are async. The **external authority must define the revocation/dispatch linearization point** (serializable transaction/consensus-backed state) and prove that a revoke committed before an enqueue-admission ticket cannot approve it. The Hub must not claim atomicity from a remote check followed by a local \`socket.send\`. An ordered one-shot ticket plus short-lived signed authorization can protect enqueue eligibility; once queued, the native effect gate is the critical final defense. No current production implementation meets this solely by adding an in-process mutex.

## C. Reconcile Hub CAS with Windows Agent CAS (owner: AI-05)

At #1089 \`src/agent/native-agent.ts\`, received mutation is currently:
\`\`\`ts
const reserved=await remoteCas.reserve(requestId,fingerprint,capability);
if (!reserved.created) return ALREADY_RECORDED;
await operationJournal.begin(...);
await operationJournal.markDispatched(...);
await executeCapability(...);
\`\`\`
**Do not reuse the Hub's \`(deviceId,requestId)\` reservation via another fresh-only CAS call in the Agent.** It would report \`created=false\` and erroneously reject all legitimate first executions. Instead extend the authority to an **explicit monotonic state machine** with distinct transitions:
\`\`\`text
UNSEEN → RESERVED → DISPATCH_ADMITTED → NATIVE_EFFECT_CONSUMED → OBSERVED_TERMINAL
              ↘ UNKNOWN         ↘ UNKNOWN                    ↘ UNKNOWN
\`\`\`
Transitions must be durably CAS-ordered, stable across loss of ACK/reconnect, and never permit a second native execution for one effect. A dispatch reservation is *not* a native execution permit. Support a distinct native one-shot consume step bound to the same stable semantic intent and exact binary/authenticated evidence, rather than accepting a Hub Boolean or reusing the \`created\` bit.

The current \`fingerprintAgentRequest(capability,input,accessMode)\` and AI-04's SHA-256 **over exact UTF-8 WebSocket frame bytes** are **not equal algorithms**. Include both digest algorithms/versions in a signed, explicit binding, or change both sides under a single owner-reviewed migration. Never compare or cast unrelated SHA values as if they were identical.

The numeric Control Plane \`authorizationEpoch\` from AI-03 is NOT the UUID \`RemoteMutationCasClient.epoch\` nor CORE \`deviceEpoch/sessionEpoch\`. Map through an independently signed native enrollment/incarnation witness; validate both trust roots and revoke/rotation invalidation. A Hub ACK or JSON-supplied receipt is never Windows native authorization.

For elevated/CORE effects keep \`CORE_EXECUTOR_DISPATCH_ENABLED=false\` and require existing \`BrokerExternalDispatchFence\`, signed bound grant, independent native OS token/image/Job readback, external CAS and **per-effect** \`admitNativeEffectOnce\` prior to any executor action. Non-elevated mutating capabilities ALSO need per-effect authorization; bypassing HIGH does not bypass owner/device revocation. Recheck before process creation, file writes and each descendant/step. If authority unavailable, deny. Reconnect/timeout/drop/invalid ACK = UNKNOWN; do not re-run.

## D. Required tests after AI-05 integration

1. Windows Node 22/24 V2-03 hung verifier (250 ms) responds **DENIED** without an extra keepalive; late success never upgrades socket.
2. Missing verifier/CAS, wrong owner/device, stale epoch, expired 30 s lease, SAFE, credential rotation, owner revoke, authority outage: **zero outbound mutation frames** and **zero native effects**.
3. Revoke before authoritative dispatch gate: **zero frames**. Revoke after frame enqueue but before native consume: possibly one frame but **zero native OS effects**.
4. Same UUID concurrent/reconnect/restart: exactly one reservation and <=1 frame; old ACK cannot settle new socket. Cross-runbook new UUID for same uncertain effect: blocked by durable semantic reservation.
5. Lost ACK, dispatch exception, missing witness, native restart, tampered receipt and crash-after-consume: permanently UNKNOWN or observed terminal, **never a second effect**.
6. Exact-head Windows Job Object, UAC/consent, kernel image provenance, S5/CLEAN-10/native ACK/security workflow gates are not removed. Physical NAVEAX/Work-PC tests only after disposable VM results.

## Release gate

A standalone in-memory test model proves only the ordering *requirements*, not distributed linearizability. Until the independent authority, signed receipt/native one-shot verifier, AI-03 migrations, unified source and Windows E2E are accepted, **DRAFT / PRODUCTION NO-GO**.


## E. Ready-to-wire socket-instance helper

AI-04 also supplies \`src/core/atomic-agent-broker-dispatch.ts\`, a narrow function
\`dispatchSocketBoundMutation({deviceId,request,connection,currentConnection,coordinator})\`.
It performs a trusted in-memory socket-instance and OPEN-state check before and
at the synchronous enqueue callback, rejecting stale sockets with **zero frames**.
AI-05 should call this function in the strict remote mutation branch of
\`AgentBroker.request()\` instead of the legacy \`sendPending()\` path, passing
\`currentConnection: () => this.agents.get(deviceId)\`. AI-05 must still install
the corresponding authenticated socket-bound coordinator and bind the native
one-time effect permit; this helper has no external revoke or OS trust by itself.

The new tests validate positive exact-frame send, missing coordinator, wrong
device, connection replacement during async verifier and disconnect after CAS
reservation. These tests DO NOT make real Windows native execution safe.
