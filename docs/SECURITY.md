# Security Model

Nexowire can execute commands and modify files on real computers. Treat a deployed hub as privileged infrastructure.

## Bootstrap protections

- HTTP binds to `127.0.0.1` by default.
- A non-loopback bind is rejected unless both MCP and native-agent bearer secrets are configured.
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

The current bearer-token model is a bootstrap mechanism, not the final public authentication design. A public ChatGPT deployment should use a proper authorization flow, short-lived credentials, secret rotation, and TLS.

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

- Window focus accepts one exact HWND, optionally restores only that window when minimized, and verifies the final foreground HWND. Focus is mutation-classified and is never treated as replay-safe.

- Screenshots are returned inline and are not persisted by the screenshot capability. Capture dimensions and encoded byte size are bounded. The structured MCP metadata omits base64 image data, and service/session-isolated agents fail explicitly when no interactive desktop can be captured. Screenshots may contain sensitive on-screen data, so callers should prefer exact-window scope over full-desktop capture.

- Keyboard injection requires one exact foreground HWND before any Unicode text or hotkey is sent. Clipboard reads are bounded; clipboard write/clear and keyboard actions are mutation-classified and are never replayed after ambiguous transport failure. Clipboard payloads and typed text remain operation inputs, not audit-log payloads.

- Windows UI Automation tree/find calls are bounded read-only inspection. Value text is opt-in and bounded, password elements never expose ValuePattern text, and action selectors must resolve to exactly one element. Invoke/set-value are mutation-classified and never replayed automatically after ambiguous transport failure.
