# #03 Windows durable NWJOB5: pre-launch stream capture integration

**Owner:** #03. **Parent source:** PR #743 HEAD `7bc16b4cd1010803a4b13cdbdf95a1c02578cade`, source CI
`39678489196` **SUCCESS**, independent QA17 `39678489203` SUCCESS,
QA03+QA17+QA19 Windows integration `39678489269` SUCCESS.
**Scope:** unprivileged source+synthetic Windows fixture only. **P0 production NO-GO**.

## Reproduced missing integration boundary

- The older branches #777 exact `c41e441a87f5d22101b8d256b1b64047a551cc0e` and #718 exact
  `3bb5c880e564336fe829d450ce1df7e310935fc5` use old
  `windows-job-owner.ts` Git blob `0b88ed4cabc29356c742a94659e35fe5ca26836a`,
  ProcessManager blob `24b23e9fcf23858cfccdb8bca0195a991287f9c6`,
  NWJOB3. Their Windows `browser-live` runs stay RED
  (`39807272228`, `39817410885` respectively) on real original
  `must not announce exited before stdout is captured` assertions.
  This is not #08 publication or quota source causation. Do not re-run
  or dilute the original red tests.
- #743 NWJOB5 `src/agent/windows-job-owner.ts` lines 117–125 attaches
  `onOutput` immediately after spawn and before awaiting native
  Job assignment and kernel proof. Volatile
  `src/agent/process-manager.ts` lines 1056–1078 uses that pre-spawn
  capture with bounded output queue, later flushes events and waits for
  stream drain before definitive exit.
- **Separate real gap:** `src/agent/process-worker.ts` durable headless
  path previously awaited `launchWindowsJob(...)` and
  `persistStatus()`, then subscribed to native guardian pipes at
  lines 448–470. Fast native roots can produce both streams during
  those asynchronous operations. The same JobOwner's early capture
  was not connected to the durable path. This is a scheduling
  vulnerability; a finite series of physical runs may not fail every time.

## Narrow source change (only #03)

- `src/agent/process-worker.ts` wires `onOutput: captureOutput`
  into `launchWindowsJob` **before guardian spawn/resume**.
  The existing `append` function serializes event writes and status
  updates with `eventChain` and `persistChain`.
- Avoid duplicate output: only non-Job paths attach direct
  `child.stdout/stderr.on('data')` listeners. Windows Job path
  keeps its JobOwner stream readers.
- Register process `close` and `error` handling before the next
  `await persistStatus()`. Reconcile a guardian already closed
  before the durable worker could attach its own close listeners:
  terminal state only after both pipes drained; pending append chain
  awaited before final `exited` persistence. No PID-only stop,
  no blindly accepted stdout marker as kernel/Job proof.
- Private desktop remains **outside** Job claims and preserves its
  separate source behavior.

## Regression evidence

New `test/windows-durable-nwjob5-early-output.test.ts`:
- Independent strict source invariant for onOutput at awaited Job launch:
  **RED** on unmodified #743 source (one test FAILED with actual
  `launchWindowsJob(... guardOnParentExit:true)` lacking onOutput).
- Real TEMP-only Windows native test repeats 16 fast durable command
  invocations, verifies **exactly one stdout+stderr marker recorded
  before returned terminal status**. On unmodified #743 16-cycle run
  happened to PASS (intermittent race, NOT a disproof). With fix:
  16 cycles PASS and source contract PASS, 0 skips on Windows.
- Existing unmodified `test/durable-process.test.ts` source
  reattach/terminal-recovery/dead-worker-UNKNOWN assertions pass.
- Existing unmodified `test/windows-job-owner.test.ts`
  includes original 12-cycle stdout-before-exited assertion,
  additional 64-cycle Job regression and durable guardian-death test.
- Existing unmodified QA19
  `test/qa-19-windows-job-hosted-fast-exit.test.ts` executes
  100 native fast exits with both pipes and exact PID/guardian
  creation FILETIME anti-spoof. Source GREEN is not a signed
  installed Broker proof.
- Independent hosted Windows workflow and full CI require exact new
  HEAD: green is never inferred from parent #743.

## No unsupported security claims

`CORE_EXECUTOR_DISPATCH_ENABLED=false`. This patch fixes a durable
sidecar **stdio listener registration order**, not filesystem/network
sandboxing, first-party signed HIGH Broker, imported DLL complete
manifest, effective low-user AccessCheck, or OS protected
`PROCESS_DUP_HANDLE` denial. Same-user synthetic
`PROCESS_DUP_HANDLE=ALLOW` (#756) remains a **P0 exposure**.
#271 writable elevated ProgramData, #551 installed signer/rollback,
#576 retained Job handle and #617 authenticated CORE owner epoch
remain physical release blockers.

No live installed Agent 1.0.5, Broker, UAC, OS ACL, native service,
D1, user files/processes, Hyper-V or ReVoltVPN VM were touched.
Only a fresh disposable synthetic native Windows Job guardian was
compiled and launched in the isolated #03 worktree.
