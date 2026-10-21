# Nexowire #16 | Independent QA for PR #703–#729

**Main exact SHA:** 754cc4364822be5fda528f54042fb22a84f19924; source-only CI 39622251466 SUCCESS. QA child branch is based on #729, not intended for main deployment.

## GitHub current exact HEAD vs superseded CI

Latest exact PR verdict: 17 full CI SUCCESS, 9 full CI FAILURE, 1 QUEUED (#721 HEAD aa16d3e0, CI 39676732876). Prior 17 SUCCESS/10 FAILURE was an older #721 head; never carry a conclusion to a changed SHA.

| PR | Head | Base | Workflow | State | Limitation |
|---|---|---|---|---|---|
| #703 | 13cef903130d | da37dcc034ad | 39658452754 | PASS | Reopen UNKNOWN and quarantine undispatched intent source; external signed effect still absent |
| #704 | 98876d163aac | 437030d288fd | 39658648859 | FAIL | Two REAL Node24 semantic failures: read after first VERIFIED chunk and forged wrong requestId ACK masked; not Windows flake |
| #705 | 36ba1b0a2cd9 | 637ff3a6e870 | 39658856961 | FAIL | Windows Broker import/updater ACL provider negative still RED; separate QA17 dedicated run 39658856958 SUCCESS |
| #706 | 6a2a1d8a2b04 | 0b43332289a4 | 39658875463 | PASS | Signed staged installer repair/source; no native installed signed full rollback |
| #707 | 5ac01095e63b | b0e0fb30d908 | 39659960377 | PASS | Transitive updater DLL signer/hash native-handle source check, no production ACL |
| #708 | fd0545dc31b1 | 437030d288fd | 39659365444 | PASS | Predispatch CAS and two-Hub stale signed publish negative source green |
| #709 | b083004b9ab8 | 637ff3a6e870 | 39658979397 | PASS | Native Windows importer ACL/path identity fix source CI green; physical installed signed Broker unknown |
| #710 | 4702b06cbad3 | 576eab8926c8 | 39658983007 | PASS | Independent revokeAndDrain signed permit/rollback source success only |
| #711 | 38dfb89a9a75 | 58ebfbf608e9 | 39659054823 | PASS | Compressed parser 4x9.5MiB seeded tests source green, no live 100+ user WSS |
| #712 | 62800af17d2a | 576eab8926c8 | 39659225895 | PASS | Owner epoch signed nonce Broker permit fence source-only, no non-restorable CAS physical |
| #713 | 688732dd7c90 | 0b43332289a4 | 39659243880 | FAIL | Windows browser-live fast-exit CI red; signed import DAG source not deployment |
| #714 | d7e5f98b5b28 | 0b43332289a4 | 39659270493 | PASS | Signed CORE rollback and offline pairing source green, no real first-party installation |
| #715 | 550b10c07df6 | 54d5451d38aa | 39659290064 | FAIL | Browser-live physical Windows Job inherited failure; diagnostics source provider separate |
| #716 | 0ca5903fae85 | 4bc4ccdbb1ab | 39659320381 | PASS | Signed postcondition ROOT boundary/crash/duplicate ACK synthetic source |
| #717 | 81f705faf24c | 637ff3a6e870 | 39659333082 | FAIL | Windows Broker protected importer ACL tests red; separate QA19 importer ACL forensics 39659333504 SUCCESS |
| #718 | bcf42c42b3b3 | 0cc9710c37d1 | 39659378084 | PASS | Quota cleanup and late UNKNOWN receipt source-only |
| #719 | 597191102dab | 99894af2c224 | 39659394811 | PASS | Queued ROOT/CORE revoke and effective Access/CAS source green, not actual high token |
| #720 | f79b3cce45b9 | 61ef8373ab98 | 39659414593 | FAIL | Browser-live Windows Job failure, WSS pairing source fix separate |
| #721 | aa16d3e0fc26 | 5daa0da17d2d | 39676732876 | PENDING | NEW HEAD full CI queued. Earlier #721 historical HEAD had separate failure, cannot carry failure or green across SHA |
| #722 | 60734cf21f0d | 50632ee93b12 | 39659428942 | FAIL | Windows browser-live fast-exit fail, physical local UAC owner-absent not attested |
| #723 | 7dc98916538c | b0e0fb30d908 | 39659567874 | PASS | Transitive DLL updater signer/hash/handle negative QA source green |
| #724 | f730943fb239 | 8b08ede8db29 | 39659574218 | FAIL | Windows browser-live fast-exit fail while compressed admission source QA isolated |
| #725 | 09c3dcaf2310 | 437030d288fd | 39659633982 | PASS | Source correction forged ACK provenance and UNKNOWN race; must replay unchanged #704 red tests on exact source |
| #726 | 8f35bb1a5eee | c46f9138b9af | 39659786915 | PASS | Native HIGH/CAS UI source fail-close tests green, not OS high token |
| #727 | 7eeb40ce2e7d | 0eaa23a44014 | 39659834387 | PASS | Isolated Windows DPAPI QA 39659834620 and full CI both SUCCESS; separate native high-token still missing |
| #728 | 52d13f432709 | e8d44653fdb4 | 39659941037 | PASS | AI Screen private child emergency stop source green, no live privileged GUI |
| #729 | 064e59b2640d | 19fe2c752e2d | 39662119627 | FAIL | QA independent RED source is deliberate P0 gate; OTHER failures Node22 general npm check and Windows durable NW_DURABLE_READY timeout must remain distinct |

## #729 failure provenance, separate P0 vs ordinary CI defects

- P0 mandatory negative job 119437584894 FAIL as designed: 10 PASS, 7 genuine missing production source contracts FAIL, zero SKIP. CORE broad signed HIGH executor not present, ROOT real 900s lease unproven, Hyper-V vm.start erroneously standard and not in typed privileged Broker allowlist, restored old SQLite journal re-admits completed requestId (#587), and durable onecall transfer start/status/cancel (#588) missing from main. Preserve every RED assertion.
- Windows browser-live job 119437584585 FAIL separately on durable ProcessManager restart output reattach: /NW_DURABLE_READY/ timed out after 28.5s. This must be investigated as Windows durable process CI/code failure, not treated as expected P0 red.
- Node22 119437584597 check FAIL includes required source P0 gates; Node24 119437584672 CANCELLED after surfacing the gates. WSL2/macOS/Linux/security-operational sibling jobs SUCCESS but cannot change overall #729 FAIL.

## Other significant PR source failures

- #704 Node24 two real semantic cancellation/forged wrong requestId ACK tests FAIL, inherited earlier #677; #725 owner source CI green on different SHA, unchanged QA #704 suite must be replayed on integrated #725 source.
- #705 and #717 Windows trusted Broker importer transitive DLL/parent effective ACL native tests FAIL even though a dedicated standalone QA Windows workflow passed; #709 fix is a distinct green source commit. Actual #271 inherited low-trust Modify remains P0.
- #710/#712/#719 externally signed CAS owner/epoch revocation source green; real non-co-restorable independent authority not installed. #727 full Windows DPAPI + isolated QA green; older #683 timeouts remain historical.

## R01–R22 4-level snapshot

Source 6 PASS, 6 FAIL, 9 BLOCKED, 1 NOT_TESTED; all 22 staging, production and incident BLOCKED.

| R | Source | Staging | Production | Original incident |
|---|---|---|---|---|
| R01 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R02 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R03 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R04 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R05 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R06 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R07 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R08 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R09 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R10 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R11 | NOT_TESTED | BLOCKED | BLOCKED | BLOCKED |
| R12 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R13 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R14 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R15 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R16 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R17 | PASS | BLOCKED | BLOCKED | BLOCKED |
| R18 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R19 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R20 | FAIL | BLOCKED | BLOCKED | BLOCKED |
| R21 | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| R22 | FAIL | BLOCKED | BLOCKED | BLOCKED |

## Release NO-GO, regardless of source green

- CORE requires actual persistent owner-revocable Windows HIGH broad elevated shell/process after one authentic LOCAL UAC approved signed Broker bootstrap; ROOT max 15min real elevated; FULL standard Windows token. No physical running installed protected signed HIGH Broker/owner epoch.
- #271 inherited Authenticated Users Modify on installed privileged executable tree, transitive imports/updaters and signed parent ACL not physically proven.
- #551 Nexowire first-party signed installer with complete original Agent signed rollback and two-device canary/local UAC not accepted.
- #587 independently operated NON-RESTORABLE monotonic CAS external owner epoch reservation/revoke witness absent, joint old journal+authority backup rollback can re-admit completed UUID.
- #588 main still does not expose durable scoped authenticated public onecall transfer API; physical signed 1GiB transfer completion evidence missing.
- Hyper-V immutable VM GUID per owner/device host plus independent postcondition Running/Off readback absent. Service running/HTTP401/consent.exe is not attestation.

## QA-only controls

- 138 longitudinal exact SHA PR records, 44 independent findings; historical GitHub open pages 100+23+0 non-atomic, no authoritative exact open total.
- Required source negative job remains enabled and red; no skip, xfail, continue-on-error, fake green, main merge or production elevated command.
- No live VM, Agent, UAC, ACL, Cloudflare, external CAS, signed production installer or user file changes.

**Production final acceptance: NO-GO**
