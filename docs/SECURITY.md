# Security Model

Nexowire can execute commands and modify files on real computers. Treat a deployed hub as privileged infrastructure.

## Bootstrap protections

- HTTP binds to `127.0.0.1` by default.
- A non-loopback bind is rejected unless both MCP and native-agent bearer credentials are configured.
- Non-loopback plaintext transport is also rejected by default. Direct TLS is enabled with `NEXOWIRE_TLS_CERT_FILE` + `NEXOWIRE_TLS_KEY_FILE` and uses TLS 1.2 or newer. `NEXOWIRE_ALLOW_INSECURE_REMOTE=1` is an explicit trusted-private-network escape hatch, not a production setting.
- Bootstrap bearer authentication accepts bounded rotation sets (`old,current,next`) so credentials can be rolled without an all-at-once outage. Matching hashes candidate/configured tokens and compares digests with constant-time equality instead of direct string equality.
- Stored MCP credentials may restrict tool names, stable device IDs, and deterministic named routing policies. Route grants authorize only the policy's current deterministic selected target; ambiguous or missing routes grant no target access.
- Stored MCP credentials default to the `user` role. `operator` credentials may inspect sensitive control-plane state such as policy checks, audit/events, and idempotency metadata but cannot mutate policy/routing/group/alias configuration; `admin` credentials may perform those administrative mutations. Legacy `administrative: true` records and `--admin` issuance remain admin-compatible. Tool allowlists still intersect role permissions, so a role never expands an explicit tool allowlist. Static bootstrap credentials and local unauthenticated loopback operation retain the full surface.
- Native agents connect outbound and authenticate to the hub.
- Without an agent secret, only loopback agent connections are accepted.
- Native-agent file operations are restricted to configured roots; the default root is the current user's home directory.
- File listing does not recurse through symbolic links.
- Command output, command duration, file sizes, directory depth, search scope, and entry counts are bounded.
- Audit records store operation metadata, not command input or file payload content.
- Process-session persistence stores metadata only; command text, stdin, stdout, and stderr are not persisted.
- Recovered live PIDs are marked orphaned and are not signaled automatically because PID reuse cannot be verified safely after restart.
- Windows registry/task/firewall mutations require exact selectors; wildcard-style broad mutations are rejected, and the implementation re-reads final state after mutation where applicable.

## Important limitation

The current bearer/stored-credential model is still a bootstrap/local identity mechanism, even with rotation, revocation/TTL, explicit roles, scoped authorization, constant-time matching, and direct TLS. A public ChatGPT deployment should still integrate a deployment-grade external identity/authorization flow and platform-backed protected secret storage.

## Provider failover

Never automatically replay a mutation merely because the first provider disconnected. A timeout can mean failed, succeeded with a lost response, or still running. Verify state before retrying non-idempotent work.

## Agent scope

`NEXOWIRE_ALLOWED_ROOTS` controls file tools. `*` intentionally disables the filesystem boundary and should only be used when unrestricted user-level file access is desired.

Shell execution can access anything available to the agent's operating-system account. Future policy work will add per-capability scopes and privilege separation.

- Text patching can require an expected SHA-256 revision; stale content raises `FILE_CONFLICT` instead of silently overwriting newer edits.

- Task graphs cap job count, parallelism, per-job output, per-job timeout, and total graph duration. Dependency failures block downstream jobs instead of launching them anyway.

- Live agent/process events are kept only in a bounded in-memory ring on the hub. They are not written to the audit log or persistent state; stdout/stderr can contain sensitive data and should be treated as transient operational output.

- Network probes are bounded by explicit timeouts. HTTP probes accept only HTTP(S), reject embedded URL credentials, expose only selected response headers, and cap GET body previews.

- Windows environment discovery lists names without values. Selected reads redact sensitive-looking variables by default; user/machine writes are exact-name mutations, verified after write/delete, and remain excluded from read-only failover replay.

- Persisted task graphs store only graph/job metadata, dependency structure, attempt counters, timestamps, exit/timing state, and a SHA-256 specification fingerprint. Command text, cwd, stdout, and stderr are not persisted. A job that was running across agent restart is marked `unknown` and is never replayed unless the caller explicitly sets `retry_unknown: true`.
- Declared task artifacts persist only requested/resolved path, size, SHA-256, and mtime metadata. Artifact contents are never copied into task state. Initial hashing and later re-verification are byte-bounded; re-verification runs through the current file path policy and reports changed/missing/unverified/error rather than silently trusting stale metadata.

- Window focus accepts one exact HWND, optionally restores only that window when minimized, and verifies the final foreground HWND. Focus is mutation-classified and is never treated as replay-safe.

- Screenshots are returned inline and are not persisted by the screenshot capability. Capture dimensions and encoded byte size are bounded. The structured MCP metadata omits base64 image data, and service/session-isolated agents fail explicitly when no interactive desktop can be captured. Screenshots may contain sensitive on-screen data, so callers should prefer exact-window scope over full-desktop capture.

- Keyboard injection requires one exact foreground HWND before any Unicode text or hotkey is sent. Clipboard reads are bounded; clipboard write/clear and keyboard actions are mutation-classified and are never replayed after ambiguous transport failure. Clipboard payloads and typed text remain operation inputs, not audit-log payloads.

- Windows UI Automation tree/find calls are bounded read-only inspection. Value text is opt-in and bounded, password elements never expose ValuePattern text, and action selectors must resolve to exactly one element. Invoke/set-value are mutation-classified and never replayed automatically after ambiguous transport failure.

- Raw pointer mutations are restricted to client coordinates inside one exact foreground HWND. Nexowire verifies the point currently hits the same top-level window before input and verifies cursor placement after movement. Global arbitrary screen-coordinate mutation is intentionally not exposed. Pointer move/click/scroll are mutation-classified and not replay-safe.

- Browser sessions use isolated temporary profiles and loopback-only DevTools endpoints. Navigation is limited to HTTP(S) and `about:blank`; page snapshots are bounded and suppress password values. DOM actions require exact unique selectors, browser clicks verify the target point is not occluded, and browser mutations are never auto-replayed after ambiguous transport failure.


- Idempotency records persist only operation key, SHA-256 fingerprint, operation ID, capability, target, timestamps, and final status. Mutation inputs and provider outputs are never persisted. Reusing a key for a different fingerprint is rejected. An in-progress record found after hub restart is converted to `unknown`, and Nexowire will not replay it automatically. In-memory confirmed results may be reused during the same hub lifetime.
- Explicit idempotency keys are accepted only for a narrow replay-safe allowlist: overwrite file writes (never append), mkdir, exact file patch, exact registry set/delete, and exact Windows environment set/delete. Unsupported mutations fail closed instead of pretending that "probably idempotent" is a security model.

- Device history stores only native-agent identity/capability metadata and connection timestamps. Route discovery never silently chooses between multiple matching computers: it returns ambiguity and requires explicit narrowing/selection.

- On Windows, broker privilege mode can bootstrap without a plaintext broker token in environment/config. The standard native agent and elevated broker use the same random token stored only as Windows DPAPI CurrentUser ciphertext. An explicit broker token still overrides this for controlled deployments. DPAPI binds decryption to the same Windows user context, so the elevated broker should run elevated as that user rather than as an unrelated service account.

- The Windows privileged-broker scheduled-task installer must itself run elevated, registers the task for the same interactive user with `RunLevel Highest`, and refuses installation when plaintext broker-token environment variables are present. The generated launcher persists only non-secret broker metadata and references the DPAPI ciphertext file.

- Mounted secret-file sources are canonicalized before reading, opened through a verified file descriptor, re-checked with `fstat`, bounded before content read, and use final-component no-follow semantics on POSIX. This closes the previous stat/read path-swap window without persisting secret contents.
- On Windows, bootstrap MCP/native-agent/relay bearer sources may instead use purpose-bound DPAPI CurrentUser envelopes created by `nexowire secrets seal`. The envelope persists only metadata/purpose/ciphertext; plaintext is passed to DPAPI through stdin, never command-line arguments or environment variables, and cross-purpose unprotect attempts fail.
