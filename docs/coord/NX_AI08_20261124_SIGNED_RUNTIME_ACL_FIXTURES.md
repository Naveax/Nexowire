# AI-08 signed runtime, installer and ACL extension
2026-11-24. Stacked on accepted #1271 5147bfa1de1cde61f62a535ea52188239164f7c2. General CI 45404253331 and Release Readiness 45404253201 SUCCESS; combined 45404253274 all four targets SUCCESS. Preserve accepted SHA. New lane required on Windows only, schema v2, no source/runtime activation change.

| Fixture | exact Git blob | minimum |
| --- | --- | ---: |
| test/windows-user-bundle.test.ts | c2d4adfbdb4f765a3c345c24e9a2d71c890dd1d5 | 4 |
| test/ai05/core-broker-install-mode.test.ts | 4e21a7aabc860495881199ac9805c73cc622065a | 4 |
| test/ai05/core-existing-agent-broker.test.ts | 17fe80b78825299efa4f351ec4399a61728a978a | 4 |
| test/ai05/core-native-hotkey-alias.test.ts | c79b488372677933dd7210fe501a6c94494821d0 | 1 |
| test/windows-privileged-runtime-trust.test.ts | 779fb882a3ef1bfe36ad2e28702c19c87fc4f0f0 | 10 |
| test/windows-runtime-shared-ancestor-acl.test.ts | 08d91da02316cdaf78192da8b795dd4f21186b78 | 2 |

25 expected additional cases; nine required Windows lanes, 53 distinct attempted file targets, 290 passing cases plus one known platform SKIP if all succeed. Linux policies unchanged. These are targets, not actual results. Strict TAP denies unexpected skips, including missing fixed installed Node/npm. Hotkey fixture tests actual PowerShell 5.1 enum conversion, not keyboard injection. Core install/discovery use injected probes; bundle rules generate strings only; signed runtime and ACL inspect actual fixed installed official Node/npm read-only. No scheduler operation, physical user consent, ACL repair or production CORE enablement.

Hosted-only preparation reads existing fixed installed runtime without modifying it. Only if the directory is entirely absent: download exact already selected Node version MSI and official checksum via HTTPS, require exact hash AND valid OpenJS Authenticode publisher, then install with no reboot on GitHub-hosted disposable Windows. Existing incomplete/untrusted runtime is rejected, not replaced. Production ACL test remains unchanged and checks every object. Preparation failure does not suppress independent source lane execution; unexpected SKIP/FAIL keeps acceptance red. New lane and all direct critical dependencies pinned; later AI-07 native-agent.ts changes require reviewed repin, no silent inheritance. No preservation CSV changes, no changes to previously green #1271.

DPAPI #1269 180398ms failure vs #1271 72321ms PASS, same four source/test blobs; positive call failure location unresolved. AI-03 #1270 comment 7133778153 requests sanitized phase diagnostics and separating cryptographic denial from infrastructure timeout. No timeout or policy relaxation. Exact child CI required. Physical runtime/owner consent/SYSTEM acceptance remains NOT_INFERRED.
