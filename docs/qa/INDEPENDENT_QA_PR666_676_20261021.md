# Nexowire #16 | 21 October Independent QA #650 #652 #666-#676

**Main HEAD** 754cc4364822be5fda528f54042fb22a84f19924 | CI 39622251466 SUCCESS, source only. **77 GitHub open PRs** and **85 historical exact-head QA records**; these are intentionally distinct counts.

## GitHub exact-head branch status

| PR | Head | Base | Run | CI | Interpretation |
|---|---|---|---|---|---|
| #650 | 5a76c826de58 | 5a52fd6eccbf | 39629695531 | PASS | Provider UNAVAILABLE, queued CORE revoke after reservation source tests, note post-reservation pre-effect epoch fence remains unimplemented. |
| #652 | 6dd516086be1 | 95304300649a | 39629996191 | FAIL | Dedicated QA provider-truth 39629996167 SUCCESS; full CI browser-live Authenticode/ACL FAIL (not stdout fast-exit). |
| #666 | 748dc6e4e761 | b3e3b7bcd6e7 | 39631675531 | FAIL | Six jobs SUCCESS, macos-agent-lifecycle-live CANCELLED; overall CI FAILURE. Worker/journal linkage source-only, no side effect. |
| #667 | 8cbf5c06dfe7 | 9266f9b65a1f | 39631999739 | FAIL | 6/7 jobs PASS, browser-live Windows Job stdout-before-exited iteration 1 FAIL; PR author reports #640 5/5 and #641 7/7 locally PASS after semantic fix; independently merge-tested physical 1GiB NOT verified. |
| #668 | 72a4f923d92c | 2ae3f0c94b1c | 39632010226 | FAIL | 6/7 jobs PASS, browser-live Windows Job stdout-before-exited iteration 1 FAIL; writer stop/deletion receipt provider source-only, Cloudflare D1 and disk release physical blocked. |
| #669 | 99894af2c224 | f5545741902c | 39632774193 | PASS | Access CORE/ROOT EFFECTIVE source signed dual evidence and dashboard source PASS; no server configured native/CAS provider, effective false by default. |
| #670 | cc5f3db53ec3 | c429ed9c7eb6 | 39633083937 | PASS | Native real Windows Authenticode module and parent ACL source proof + disposable own token tests PASS; not actual installed Broker running image, imported DLL/protected updaters/elevated token/owner epoch. |
| #671 | 1e9425c97021 | 754cc4364822 | 39632434610 | PASS | SQLite signed receipt one-time/reconnect/revoke/issuer rotation source tests; restored DB and multi-tenant WSS outside source not independently anchored. |
| #672 | 84714bb77ec0 | ea4229b9ed34 | 39632489293 | PASS | Signed installer, protected recursive imports/updater and same owner Bootstrap stage source tests only; no genuine Nexowire first-party signed release or UAC/VM canary. |
| #673 | 2c78cedc6ee9 | fddbdfea8d3b | 39632538963 | PASS | Temporary native handle/rename/ADS/junction negatives + source ACL proof tests, provider not implemented/wired, no protected real file ACL verified. |
| #674 | 9dc676ac793c | cf58e6882e44 | 39632610866 | FAIL | 6/7 jobs PASS, browser-live Windows Job stdout-before-exited iteration 10 FAIL; seeded source timing non-repeatable, 4x9.5MiB real parser run physically BLOCKED low disk. |
| #675 | 257d89e168c5 | 754cc4364822 | 39632701546 | PASS | Browser-bound one-time OAuth nonce/cookie and CAS source tests green; D1 storage migration/wiring not deployed, login could fail closed if merged without wiring; OAuth is not Windows elevation. |
| #676 | b935a594a68c | 4e0cb8f5a00d | 39634099233 | PASS | Source PostgreSQL and HTTPS external atomic owner grant CAS, signed revoke/re-pair and lost ACK tests green, no non-restorable real remote witness deployed. |

## Independent not-green evidence

- #666 overall CI 39631675531 FAILURE: macOS agent-lifecycle job CANCELLED, all other six SUCCESS. No full source acceptance.
- #652 dedicated Windows Provider Truth QA 39629996167 SUCCESS, but full CI 39629996191 FAILURE with Authenticode UNAVAILABLE and inherited parent Modify null. Neither equals signed live Broker attestation.
- #667/#668/#674 CI FAIL browser-live Windows fast-exit stdout-before-exited at iterations 1, 1 and 10; exact runs 39631999739, 39632010226, 39632610866. Each remaining six jobs SUCCESS. Avoid stale six-of-seven green.
- #667 author reports existing independent #640 cancellation 5/5 and #641 two-Hub CAS 7/7 PASS after code fix, but QA16 did not rerun them on exactly #667 HEAD. Historical #640 two true cancellation semantics failures remain in their old independent SHA record; newer behavior not independently accepted.
- #650 and #669/#670/#671/#672/#673/#675/#676 exact source CI SUCCESS. Sources are on DRAFT feature branches and cannot authorize production.

## R01-R22 acceptance by distinct layer

Source 6 PASS / 6 FAIL / 9 BLOCKED / 1 NOT_TESTED. All staging, production and original incident 22/22 BLOCKED.

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

## Physical production NO-GO

- #271 legacy elevated runtime on Naveax had inherited Authenticated Users Modify. Protected installed Broker ACL readback unavailable; #670 disposable native PowerShell proof is not installed running Broker PID/image/import ancestor/updater ACL proof.
- #551/#672: Source signed protected recursive installer/import+rollback contract CI green, but real Nexowire-signed native bootstrap, complete signed old Agent 1.0.5 rollback, genuine once-only local UAC physical approval and two-device signed canary NOT performed.
- #587/#676: Real external non-co-restorable monotonic authority NOT deployed. Source PostgreSQL + HTTPS atomic owner CORE epoch CAS green, but independently verified physical owner revoke/re-pair, SQLite J+A rollback replay prevention and live elevated dispatch absent.
- Real CORE high Windows token, persistent broad elevated admin shell/process, ROOT 15 minute lease, signed protected running Broker and independent Hyper-V VMId Running readback remain missing. #669 EFFECTIVE status source uses synthetic signing and defaults false without trusted native/external providers.
- #671 WSS signed receipt local SQLite one-use does not prove global rollback resistance. #675 OAuth cookie-bound one-time state needs D1 migration and both route stores wired before deploying; OAuth login never attests physical Windows elevation.
- #674 source fixed seed controls content hashes, not real p95/p99 timings. Opt-in 4x9.5 MiB true parser run blocked by disk-free preflight; no 100+ real WSS proof.

## Controls

- QA16 source-only changes: machine readable snapshot, 85 entry ledger, 33 findings, four-level matrix, independent exact-head provenance test; preserved separate deliberately red native feature tests.
- No live VM/Agent/Broker/UAC/ACL/user data/Cloudflare/DB mutation, no unsafe P0 PR merge, no skipped red tests.

**Final Acceptance: PRODUCTION BLOCKED.**

Files: QA_20261021_PR650_652_666_676_EXACT_EVIDENCE.json, PR_SOURCE_AND_RELEASE_GATES.json, QA_BLOCKING_FINDINGS_CURRENT_MAIN.json, cross-project-final-acceptance.json.
