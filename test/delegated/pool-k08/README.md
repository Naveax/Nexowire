# T-249 — MCP response redaction, offline sample QA

This test uses the **real** diagnostic redaction helper and inspects the
`toolResult` source path, but never starts Nexowire or submits an MCP call.
It exercises synthetic success, error, nested headers, URL query parameters,
private keys and circular records. Every test credential includes the marker
`FAKE_TEST_ONLY`; no real token, payment or device data is present.

```bash
node test/delegated/pool-k08/mcp-response-redaction.test.mjs
```

The safety claim is narrow: known sensitive key patterns and token-like strings
are masked in these **fixtures**. The `toolResult` source currently builds both
its JSON text and structured channels from the same redacted data. This is
not proof that every possible HTTP header, nested provider payload, binary
image, or production log path has been reviewed.

**Open security-owner question:** the generic recursive redactor's sensitive
field-name list does not explicitly include `cookie` or `set-cookie`. These
can be session-bearing headers in some systems, but whether such headers can
reach the MCP diagnostic payload is **unverified**. The TODO records this as
review work, not a confirmed Nexowire exploit. K08 must not modify the
security-owned redaction source under the team protocol.
