# AI-02 | current source handoff (1 November 2026)

- **State:** source hardening delivered on own branch; independent source QA and physical acceptance pending. **CORE PRODUCTION NO-GO**.
- **Draft PR:** https://github.com/Naveax/Nexowire/pull/993 ; `ai/02-enrollment-hardening-20261031`, stacked on Draft #984 exact base `9d0f35607d4cde87bd031e2da77855cfaf570c31`; no merge or rebase.
- **Last reviewed source HEAD before this documentation/installer candidate:** `4c2b379dd12c4b704d19e5804d83afae44dc10a7`. Resolve **current exact HEAD** from the live PR, not this historical snapshot.
- **Baseline same-HEAD run:** #41246829570, Node 22/24, Linux-native, WSL2, macOS, Security, Windows native **7/8 SUCCESS**; browser-live was **in_progress** at last verified read. Do not claim this full run PASS until terminal status is checked. Windows native job #124671948122 **SUCCESS**: .NET 10 compile 0 errors/0 warnings, 5/5 native tests PASS/0 FAIL/0 SKIP and a SHA256-manifested 192-file bundle `installed=false`.
- **Previous whole green baseline:** exact SHA `2fef25808393eb84232872507e2d316e9a23b327`, CI #41243991732 **SUCCESS 8/8** with Windows native 5/5. That success must not be transferred to the new source SHA.
- **Latest own source changes:** native IPC success requires canonical signed P-256 grant and matching signed witness for the actual submitted challenge; malformed, tampered, stale or foreign reply is rejected. Native physical-console owner checks are repeated after delayed TPM creation / revoke fence. Corrupt stored authority SPKI fails closed. `mayDispatch=false` remains fixed.
- **This candidate:** explicit `install.ps1 -Execute` required to reach mutation; `-PreflightOnly` stays read-only; missing or both switches fail with distinct diagnostic errors. Disposable Windows negative tests call neither actual `-Execute` nor SCM.
- **External P0:** verified signed Agent installation identity/executable trust and same-owner hostile pipe peer, AI-03 independently pinned issuer/mTLS/monotonic external revoke+generation/CAS, AI-08 exact combined-head QA, disposable Windows SCM/TPM/owner consent/reboot/offline revoke acceptance.
- **No UAC automation, physical enrollment, live device/service/SCM changes, production CORE activation, merge or deploy.**

## In-scope additional CI fixture verification

The next commit extends read-only Windows installer negatives against
malformed manifests **whose exact manifest SHA-256 is itself correctly
re-pinned**. This is separate from source-signer authenticity. Actual
production installation is still blocked by independently authenticated
installed Agent identity, pin custody, physical console and real SCM acceptance.

## Next AI-02 test/handoff candidate (do not promote to PASS before exact CI)
- Added testable local owner consent decision (only explicit Win32 Yes=6), malicious signed IPC status/attest envelope variants, >16 KiB/native duplicate-frame negatives and disposable Windows installer identity/runtime replacement negatives. All source/tests exclusively AI-02 owned; no service/user credential/UAC touched. The cancelled-UAC physical negative remains NOT TESTED and must not be confused with simulated cancelled MessageBox.
- Prior exact HEAD `8d61b16e0e95adc1202c384fb8f2ddf92c0bd8ba`, workflow #41249336072 7/8 SUCCESS at last read, final browser status pending. Subsequent HEAD must have matching own CI run. Details in TEST_EVIDENCE and INTEGRATION_REQUEST.
