# AI-04 TEST EVIDENCE

## Pre-existing immutable candidate evidence
- #950 exact HEAD `4c92f676c5d0ce0dd6c85a6288912ab21bf4a80c`: CI run `40752196776` completed SUCCESS (7 jobs), unrelated to this new commit.
- #952 exact HEAD `c6383530364ae7765982a988aed54d3c9a093752`: no PR-triggered workflow run returned at inspection. Do not infer PASS.
- #980 exact integration HEAD `7e4093c30c1ead3cd22888184450c34aef4737da`: CI `41113730982` reported SUCCESS. Its receipt source/test blob SHA matched #950; its Job C/test blob SHA matched #952.

## AI-04 new negative coverage
- `test/ai04-broker-binding-snapshot.test.ts`: positive disposable fixture + initial, recent, and immediate accessor/ABA denial + throwing Proxy denial.
- Fixture-only cryptographic/OS trust: NO. Not a genuine external CAS or Windows kernel readback.
- Local commands `node --test --import tsx ...` / `npm run typecheck`: NOT RUN locally because the full repository checkout and dependencies are unavailable in the sandbox; exit code N/A.
- Windows MSVC / Job kernel probe: NOT RUN; current environment is Linux. Exit code N/A; no physical acceptance.
- New exact HEAD CI ID and job exits must be checked on PR after submission. CI success still does not prove real installed Broker protection.
