# CORE source integration after v1.0.8

This source-only candidate merges released main a19a228dc6f19fd484cf935e941a00ea625233f8 with #970 exact head 5e09c01a1f43b25eaa6b2833dfa191bfdea56b4c, preserving both histories. It is not an authorized CORE activation or production deployment.

## Conflict resolution

- Retain both Windows WAL/startup suites from 1.0.8 and every new CORE/session/WebAuthn/AppContainer/manifest and Broker fixture job.
- Retain the stronger offline CI-evidence boundary and all added negative assertions from the CORE lineage.
- Keep 1.0.8 bounded startup diagnostics and singleton cleanup. Validate existing WAL read-only during local initialization; do not initialize/recover the mutating journal until a trusted external CAS reservation succeeds. Read-only diagnosis remains available without CAS; mutation admission stays denied.
- Keep all 1.0.8 updater/launcher encoding and fresh-startup acknowledgement changes.

## Local validation

TypeScript and build PASS. Focused WAL/actual disposable Agent CLI/startup/CI-evidence regressions: 73/73 PASS, zero skips. Additional authority/consent suites: 60 total, 26 PASS, 34 explicit absent-PostgreSQL skips, zero failures. Full check: 2739 total, 2383 PASS, 2 FAIL, 352 SKIP, 2 TODO. Both failures are the previously reproduced local uv_interface_addresses environment restriction in unchanged Tailnet staging tests; no network assertions were weakened. Real PostgreSQL and Windows cases require this candidate's own GitHub jobs. CRLF is retained where inherited; whitespace check with cr-at-eol PASS.

## Required acceptance

CORE_EXECUTOR_DISPATCH_ENABLED remains false. No installed consent service, hardware ceremony, independent production CAS/restore custody, publisher/installer, arbitrary-worker containment or two-PC CORE acceptance is claimed. UNKNOWN/STOP/tombstones remain intact. A successful fixed-payload kernel diagnostic does not prove production pending-I/O or revoke drain.

The separate released-1.0.8 second-device rollout is not this source candidate and must never install this unaccepted CORE integration as a shortcut.
