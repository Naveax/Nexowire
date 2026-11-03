# MCP error wording — static user guidance audit (K08 / T-123)

Source: `src/mcp/http.ts` and `src/protocol/error-contract-v2.ts` at
`Naveax/Nexowire` `main` `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`.
This is a **source-backed QA matrix**, not an implemented new UI translation or
proof of a live ChatGPT/MCP session. The API responses remain machine-readable;
the suggested explanations below are for future consumer-facing copy review.

| Observed contract | Safe plain-language interpretation | Unsafe instruction to avoid |
| --- | --- | --- |
| HTTP 401 `MCP_AUTH_REQUIRED`, `reauthorize` | Your connection needs sign-in again using the official flow. | Ask the user to paste tokens/secrets into a chat. |
| HTTP 503 `MCP_AUTH_VERIFIER_UNAVAILABLE`, `retry_later` | Verification service is temporarily unavailable; wait and retry later. | Misdiagnose an outage as an expired account and require re-login. |
| HTTP 403 `MCP_TOOL_NOT_AUTHORIZED` | This operation is not permitted for the current connection; request correct scoped access if appropriate. | Retry with a different tool to evade the restriction. |
| `AGENT_OFFLINE` with observed connection failure | Check whether the target machine and Agent are connected. | Assume a prior changing operation never happened. |
| `MCP_TARGET_NOT_AUTHORIZED` | Select an explicitly authorized device or ask its owner for scoped access. | Auto-select an unauthorized machine. |
| `IDEMPOTENCY_STATE_UNKNOWN` / `MUTATION_STATE_UNKNOWN` | Check the original operation and verify its effects before any new attempt. | Automatically repeat a potentially completed mutation. |
| Unrecognized error without emitter evidence | The cause is not yet known; preserve the error ID and inspect correlated logs. | Claim a specific provider, Windows, or OAuth root cause. |

Run without a network connection or npm dependencies on Node 24:

```bash
node test/delegated/mcp-ux-k08/mcp-error-language.test.mjs
```

Coverage: fixed HTTP response fields, negative response drift fixture, real
`classifyFailure` behavior, authorized-scope guidance, and fake-secret
redaction. **Not covered:** localization quality judged by users, UI layout,
OAuth account integration, live device failures, or end-to-end retry behavior.
