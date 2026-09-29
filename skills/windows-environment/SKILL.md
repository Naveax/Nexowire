---
name: windows-environment
description: Inspect and safely change exact Windows environment variables across process, user, and machine scopes with sensitive-value redaction and verification.
version: 0.1
requires: windows.environment.list, windows.environment.read, windows.environment.set, windows.environment.delete
---

# Windows Environment

Use structured environment tools instead of scraping `set`, `Get-ChildItem Env:`, or the registry.

## Workflow

1. Use `windows_environment_list` to discover names without exposing values.
2. Read only the exact variables needed with `windows_environment_read`.
3. Sensitive-looking names are redacted by default. Reveal them only when the value itself is necessary for the requested work.
4. Before changing an existing variable, read its current value and preserve any components that must remain.
5. Use `windows_environment_set` or `windows_environment_delete` for one exact variable.
6. Treat `verified: true` as confirmation that the requested scope was updated.

## Scope behavior

- `process`: changes the running Nexowire agent environment and therefore affects child processes launched afterward.
- `user`: changes the current Windows user's persistent environment. Existing processes do not inherit it retroactively.
- `machine`: changes the persistent machine environment and may require elevation. Existing processes do not inherit it retroactively.

## Safety

- Never bulk-export environment values just to inspect configuration.
- Do not reveal sensitive values merely because a variable name exists.
- PATH-like variables must be read and reconstructed carefully. Do not replace PATH with a partial fragment.
- Set/delete are mutations and must never be automatically replayed after ambiguous transport failure.
- Prefer process scope for temporary build/test configuration and persistent scopes only when persistence is actually required.
