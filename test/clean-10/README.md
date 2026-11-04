# CLEAN-10 Error Contract / no-replay acceptance

Scope: source-only, standalone Draft PR based on `main@939b4d6beecf996f2750c736c5d4b4beb7b64488`.
No direct `main` merge, CORE D1, Cloudflare, Windows Guardian or installed Agent modifications.

## Immutable source QA

- #599 HEAD `0c24d2acf14b4d10f1f37a9f7072a30799665386`:
  - `test/qa-02-error-contract-no-replay.test.ts`, blob `0d6f2d5d35c4c73dbb361c899a1fd04bae301a7c`.
  - `test/qa-02-windows-output-ordering.test.ts`, blob `75b01033445772b5864a19495a2c8d7c211a0524`.
  - Error path from `src/mcp/create-server.ts`: add `operationId` to `idempotency` without modifying dispatch or replay conditions.
- #781 HEAD `89a865363829c8c30a74de1516e53a697549c05b`:
  - `test/qa-18-durable-runbook-cloned-unknown-negative.test.ts`, blob `6779589873fb35a7779701dbd9046c9a4007e7bc`.
  - This historical test deliberately **passes when the unsafe clone-replay behavior exists**. Its PASS is NOT no-replay acceptance.

All three original QA files must remain byte-identical to their source blob SHA. Do not weaken RED assertions.

## Acceptance matrix

| Test | Required claim | Security gate |
| --- | --- | --- |
| QA-02 lost ACK | Exactly one mutation request across same-key retry and Hub restart; same operation UUID; no secret in MCP/audit | Must PASS |
| CLEAN-10 timeout/reconnect | Post-dispatch timeout must stay UNKNOWN; no automatic redispatch; changed-payload key rejected | Must PASS |
| CLEAN-10 concurrent reservation | 16 concurrent duplicate admissions result in one UUID; after restart `in_progress` becomes `unknown` | Must PASS |
| QA-18 historical negative | Proves current cloned runbook can re-dispatch with a new runbook ID | Unsafe negative, must not be misreported as safety PASS |
| CLEAN-10 runbook RED | Lost mutation ACK recorded UNKNOWN; cloned semantic effect never dispatched again without independent authority | Must PASS **before** no-replay GO; expected RED on unchanged `src/agent/runbooks.ts` |
| QA-02 Windows output | On a genuine Windows runner, both stdout and stderr must precede terminal success, including 8 synthetic Job starts | Physical Windows execution required |

`src/agent/runbooks.ts` is outside CLEAN-10 ownership. If the RED test fails, do not change that file in this PR, skip the test, forge an authority receipt or declare no-replay GO. Refer the remediation to the runbook/JournalAuthority code owner and re-test exact new SHA.

## Reproducible targeted commands

```sh
node --test --import tsx test/qa-02-error-contract-no-replay.test.ts
node --test --import tsx test/qa-18-durable-runbook-cloned-unknown-negative.test.ts
node --test --import tsx test/clean-10/*.test.ts
npm run typecheck
npm run build
```

On Windows only, also execute:

```powershell
node --test --import tsx test/qa-02-windows-output-ordering.test.ts
```

CI source green is not physical native Broker/Windows or rollback-independent CAS acceptance. Do not remove the original RED assertions. Missing actual Windows execution, authenticated cross-runbook logical-operation identity and external monotonic authority mean **production NO-GO**.
