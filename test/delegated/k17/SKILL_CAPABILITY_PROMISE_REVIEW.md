# T-393 — Skill catalogue capability/description promise review

Issue: [#780](https://github.com/Naveax/Nexowire/issues/780), associated reliability topic [#539/R17](https://github.com/Naveax/Nexowire/issues/539). Current main source snapshot `4e7db16f4233048a956664bef6b607781eb63fb7` (2026-11-07).

## What is grounded

- The 45 shipped manifests reference only known entries in `CORE_CAPABILITIES`; no unknown capability was found.
- Four skills declare `mutation: read-only` and a broader capability in their alternatives or preferences. `READ_ONLY_CAPABILITIES` does not classify `shell.exec` or `workspace.checks` as read-only. This is a **metadata/description promise review**; it does **not** establish that a mutating command was actually executed.

| Skill | Declared promise | Capability not classed read-only | Manifest position | Review question |
|---|---|---|---|---|
| `incident-triage` | `read-only`, `replay: safe` | `shell.exec` | `requires_any`, 3 groups | Is a command allowlist/readback contract enforced, or must this be described as conditional? |
| `network-troubleshoot` | `read-only`, `replay: safe` | `shell.exec` | `requires_any`, 2 groups | Can shell fallback be proven read-only for the exact commands? |
| `tls-diagnostics` | `read-only`, `replay: safe` | `shell.exec` | `requires_any`, 2 groups | Does the native TLS fallback enforce a bounded, non-mutating command? |
| `verify-before-finish` | `read-only`, `replay: safe` | `workspace.checks` | `prefers` | Checks may build/test and write generated artifacts; should the classification be `mixed`? |

No runtime capability, admission, authorization, replay, or process code is changed. The owner must decide whether restrictions are enforced elsewhere, descriptions need a limitation, or the skill metadata should be revised. The test deliberately records the **eight review references** across these four manifests so this mismatch cannot silently disappear.

## Reproduce and boundaries

```sh
node --import tsx test/delegated/k17/issue780-capability-promise.test.ts
```

Three offline tests: known capability membership; full catalogue review candidates; injected required/alternative/preferred capability negative. A passing test means the inventory matches this snapshot, **not** that the four concerns are resolved. No shell fallback or workspace check was executed. Windows/device acceptance, hosted CI and runtime-sandbox proof are NOT_RUN.
