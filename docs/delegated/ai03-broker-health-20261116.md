# AI-03 Windows Broker health timing — 2026-11-16

## Reproduction and evidence

- Prior integration SHA: `6deb0e28dd5bf2cf9339d320ea549ae2f8c0ab1e`.
- Hosted AI-03 Windows Authority workflow run `43894578670`: both Node 22 and Node 24 Windows jobs failed the **same** disposable Agent-to-Broker HTTP callback test, each with 9/10 assertions passing. The observed thrown code was `CORE_EXECUTOR_DISPATCH_NOT_INSTALLED`; this is a fail-closed fallback and is **not** proof of unauthorized execution.
- The Broker `/health` handler synchronously obtains a fresh Windows token check with a PowerShell process timeout of 15,000 ms, while `PrivilegedBrokerClient.probe()` previously aborted its HTTP request after 5,000 ms. A slow health read can therefore appear unreachable before the token inspection completes. This is a source-backed timing mismatch, not proof of the exact hosted OS scheduler delay.
- Work-PC baseline AI-03 tests were 10/10 PASS. No physical SYSTEM or elevated token acceptance was performed.

## Candidate correction

- `src/agent/privileged-broker-client.ts`: raise the bounded health-probe transport cap from 5,000 ms to 20,000 ms, still respecting lower caller-specific `timeoutMs` limits. Normal Broker execute timeout and all authorization checks are unchanged.
- `test/ai03/local-owner-agent-broker-routing.test.ts`: add a **synthetic** authenticated loopback health server delayed 6,200 ms, asserting reachability without claiming HIGH/elevated token evidence.
- Local Windows combined AI-03 suite: **11/11 PASS**, zero skips; TypeScript and build PASS.

## Limits

The new 20-second cap may increase the maximum wait for an unresponsive but connected local Broker; connection refusal still fails early. The hosted Windows 22/24 workflow on the new exact HEAD is the required independent regression check. This change does not authorize CORE dispatch, invent a SYSTEM token, remove owner admission, grant physical-console control, or affect live Broker tasks and credentials.
