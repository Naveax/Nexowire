# V2-06 Independent adversarial evidence | 2026-11-04

## Scope and immutable source baseline

- Repository: Naveax/Nexowire. Owned Draft PR: #1044, branch ai/11-connection-v2-negative-20261102.
- Parent #1003 exact SHA: 30a905351c4bb91ad279e1f3532f8416c421ff67.
- Original #1044 exact SHA: 4d8f215f36de7fe05e85a9c19fc40cc35716d705.
- Original three test blobs at that SHA, preserved byte-for-byte in this change:
  - test/ai11-cloudflare-address-and-credential-custody.test.ts: blob f74ee761bfe00ff304b8c6070a26654c7c481e88, 118 lines.
  - test/ai11-cloudflared-path-race-negative.test.ts: blob d75ab8ddcc8ab887220bea203026f1ed98eb77a9, 95 lines.
  - test/ai11-connection-v2-negative.test.ts: blob 963393d00cc3368b9c76a7d8e9bb8cd4e455b706, 179 lines.
- Baseline comparison #1003...#1044: ahead 5, exactly three additions, 392 lines added, zero deletions. No src/ files changed.
- Independently observed: no review submissions and no unresolved review threads for #1044 at audit time. The PR is DRAFT.

## Original assertion inventory, preserved

The map below enumerates all test cases and the significant strict assertion sets, including fixture preconditions. All expected-pass/expected-fail semantics remain intact. A successful denial at the wrong boundary must not be counted as proof of the named vulnerability.

| Original file | Test/assertion set | Security mapping | Original #1044 evidence |
|---|---|---|---|
| address-and-credential-custody | Every forbidden mapped IPv6, compact/octal IPv4, reserved and metadata authority is excluded; assert.deepEqual(accepted, []) | P1-C public publication admission | FAIL |
| address-and-credential-custody | Real credential mode readback equals 0640/0644; temporary Hub and port have valid AddressInfo | P1-D fixture integrity | PASS (fixture precondition) |
| address-and-credential-custody | Each 0640 and 0644 credential causes assert.rejects with custody-specific error, never an unrelated failed publisher/network check | P1-D POSIX permission custody | FAIL |
| cloudflared-path-race-negative | Local OAuth health/metadata passes; two loopback listeners bind, a post-checksum rename is armed; assert.equal(markerExecuted, false) | P1-A checksum-to-spawn TOCTOU | FAIL: marker executed |
| connection-v2-negative | Valid hostname preserved; eight explicit loopback/private/link-local authorities must throw | P1-C publication admission | FAIL |
| connection-v2-negative | Four non-HTTPS/userinfo/query/fragment authority strings must throw | P1-C URL canonicalization | FAIL |
| connection-v2-negative | Five Agent/admin/unknown/query path probes do not match MCP ingress and final route is http_status:404 | MCP/Agent ingress scope | PASS |
| connection-v2-negative | Doctor sends no Authorization, sets redirect:error, makes exactly one offline probe and returns publicBoundaryVerified=false, authenticatedToolVerified=false and PUBLIC_CONNECTION_UNAVAILABLE | OAuth fail-closed diagnostic | PASS, simulated offline only |
| connection-v2-negative | Device authenticate response and single call are observed; actual request init.redirect must equal error | P1-C credential-bearing Agent auth POST redirect | FAIL |
| connection-v2-negative | Presence response and single call are observed; actual request init.redirect must equal error | P1-C credential-bearing Agent presence POST redirect | FAIL |
| connection-v2-negative | Real disposable native executable has independently computed SHA matching profile, fake Hub valid; assert.rejects requires publisher-specific reason | P1-B profile hash confusion, unsigned/wrong publisher | FAIL |

Counting line-level assert expressions is not equivalent to counting attack variants: one loop validates 8 URLs, a second loop 4 URLs, and the custody test runs two subtests. All three source blobs must remain identical under any future integration.

## Added V2-06 fixtures

- test/v206-control-plane-redirect-real-http.test.ts: two genuine 127.0.0.1 HTTP servers, 307 redirect and a second recipient that records whether protected POST credentials reach it. No fetch substitute and no outbound traffic. Covers Agent credential verification and presence with bounded 1500ms request timeout.
- test/v206-linux-file-identity-negative.test.ts: disposable actual Linux inodes/modes: hardlinked tunnel credential, mode-0777 parent, hardlinked binary, credential symlink. Each requires rejection at the specific security boundary. No synthetic mock identity and no live account or external endpoint. A non-Linux runner counts as NOT_RUN, never PASS.

New fixtures are intended to be RED against the original vulnerable #1003/#1044 and GREEN only when their relevant source-owner patches are actually present. Do not invert expectations or mark expected failures as success.

## Evidence tied to exact SHAs and existing CI

| Candidate / command | OS/job | Result | Evidence and limit |
|---|---|---|---|
| #1044 @ 4d8f215f; npm run check | GitHub Actions Linux Node 24, test(24) job 125136510278 | FAIL (exit nonzero) | CI run 41402284467, Node TAP: P1-A replacement marker executed; P1-B nonofficial hash was accepted; P1-C unsafe authorities and redirect options fail; P1-D 0640/0644 unexpectedly accepted. TAP includes 10 failed items. |
| #1044 @ 4d8f215f; Windows browser-live verification | Windows job 125136510191 | FAIL (exit nonzero) | Run 41402284467: task stop must stop managed parent. Descendant cleanup cannot be inferred from Task Scheduler Ready. |
| #1077 @ c1dd2521; npm run check | Linux Node 24, job 126516759620 | FAIL (exit nonzero) | Run 41812885695: original P1-C publication admission and Agent redirects remain RED. No all-green claim. |
| #1077 @ c1dd2521; browser-live | Windows job 126516759824 | FAIL (exit nonzero) | Run 41812885695: Windows credential custody test, immutable-launch test and parent-stop assertion fail; failures must not be relabeled as safe platform skip. |
| #1074 @ 82c596d9 | Exact-source CI | NOT_RUN / UNVERIFIED | Historical checkpoint; branch advanced during this audit. No matching run or fetchable ref at this SHA in the connector after refresh. |
| New V2-06 files on this commit | Exact-source CI / local Node | NOT_RUN until matched automatic workflow evidence exists | No local GitHub checkout: network DNS to github.com unavailable. No results fabricated. |

CI URLs:
- https://github.com/Naveax/Nexowire/actions/runs/41402284467
- https://github.com/Naveax/Nexowire/actions/runs/41812885695

## Threat matrix and remaining independent acceptance

| Threat / gate | Baseline | #1077 P1-A/B/D source | #1074 P1-C source | Integrated proof |
|---|---|---|---|---|
| P1-A checksum/spawn TOCTOU | FAIL (executed marker) | Linux descriptor-bound staging implemented, independent same-image acceptance NOT_RUN | Not in scope | NOT_RUN |
| Binary path swap / hardlink | Path swap FAIL; hardlink added as unrun fixture | Hardlink check implemented; Windows immutable-launch FAIL | Not in scope | NOT_RUN |
| Symlink and Windows reparse | Existing POSIX symlink denial by lstat; reparse NOT_RUN | POSIX nofollow guard implemented; real Windows reparse NOT_RUN | Not in scope | NOT_RUN |
| P1-B wrong publisher / unsigned / profile hash | FAIL | Official digest policy implemented, but Windows native immutable image and physical signature proof NOT_RUN/FAIL | Not in scope | NOT_RUN |
| Self-signed Authenticode | NOT_RUN | NOT_RUN (needs actual Windows certificate and signature verification fixture) | Not in scope | NOT_RUN |
| P1-D mode / hardlink / parent / owner / ACL | FAIL on 0640/0644; owner/ACL NOT_RUN | Source-specific checks implemented; Windows credential/parent ACL acceptance FAIL | Not in scope | NOT_RUN |
| P1-C redirect credential leakage | FAIL (missing redirect:error) | Not in scope | Prior 3ba58d2/dc683 CI reported targeted redirect tests PASS; new exact HEAD must be checked | NOT_RUN |
| P1-C DNS rebinding / alternative IP / metadata | FAIL for published URL admission | Not in scope | DNS pin/strict URL source added, publication boundary outside owner allowlist | NOT_RUN |
| Wrong device / owner / revoked grant | Existing simulated WSS negative tests PASS in Windows browser-live | Not in scope | No dispatch-time epoch fence in owner scope | NOT_RUN physical |
| Expired/revoked credential, 101-before-auth | Existing local tests only; no independent offhost proof | Not in scope | Not sufficient | NOT_RUN |
| Cancellation then UNKNOWN/no-replay | Existing contracts reported by owner, not independently exercised for merged siblings | Not in scope | Dispatch-time revocation fence outstanding | NOT_RUN |
| Socket/child-process cleanup | Windows parent-stop FAIL | Windows cleanup not fixed by #1077 | Not in scope | FAIL/NOT_RUN |
| OAuth actual public TLS/WSS | Doctor offline denial PASS | Not in scope | Not in scope | NOT_RUN |

## Security verdict (fail-closed release gate)

- P1-A: FAIL baseline, candidate partial, integrated NOT_RUN.
- P1-B: FAIL baseline, Windows native launch and publisher chain NOT_RUN.
- P1-C: FAIL baseline and remains RED at publication boundary; DNS pinning alone is insufficient.
- P1-D: FAIL baseline; Windows custody/ACL physical acceptance FAIL/NOT_RUN.
- OAuth: offline fail-closed diagnostic PASS; actual hosted resource/audience/TLS NOT_RUN.
- WSS: local negative revocation and wrong-device checks exist; actual 101-before-auth offhost with Hub auth NOT_RUN.
- Revocation: simulated disconnect tests exist; dispatch-time no-replay/lease fence on combined SHA NOT_RUN.
- Overall: **NO-GO**. Keep Draft. Neither a partial sibling green nor two unrelated green CI runs can certify the combined source tree.

## Exact-SHA commands for disposable QA runners

- npm run typecheck
- node --test --import tsx test/ai11-cloudflare-address-and-credential-custody.test.ts test/ai11-cloudflared-path-race-negative.test.ts test/ai11-connection-v2-negative.test.ts
- node --test --import tsx test/v206-control-plane-redirect-real-http.test.ts test/v206-linux-file-identity-negative.test.ts
- npm run check
- Windows: node --test --import tsx test/cloudflare-connection-lifecycle.test.ts
- Review job IDs and attempt on an exact SHA; never rerun an active workflow for the same SHA/workflow/input.

## Handoff to source owners and V2-08

1. #1003 source owner: enforce public HTTPS authority checks at cloudflareConnectionConfig admission; reject metadata, IPv4/IPv6 aliases, loopback/private and noncanonical URL before tunnel publication. Fix Windows parent-and-descendant shutdown.
2. #1077 source owner: supply reproducible true Windows immutable launched-image binding and actual SID/DACL/ACE custody checks, not synthetic signed-file acceptance. Retain Linux descriptor/inode negative and existing original assertions.
3. #1074 source owner: complete exact-SHA redirect real HTTP collector + DNS A/AAAA pin tests and integrate public publication-boundary policy via agreed source ownership; enforce dispatch-time grant epoch separately.
4. V2-08: independent combined-SHA revoked/wrong-device/auth-before-101, 60s revalidation with a bounded 5s decision, cancellation -> UNKNOWN, zero re-dispatch, and socket/child cleanup. For each outcome record source SHA, OS, command, exit code, targeted assertion and CI job. Until that arrives, explicit NOT_RUN.

Safety: no src/** edits; no CORE, live PCs, DNS, Cloudflare tunnel, service credentials, user tokens, deployment, merge, or branch deletion. All local credentials in fixtures are synthetic.


## V2-06 CI follow-up (supersedes earlier NOT_RUN for the first V2-06 commit)

- **Exact head SHA 32e1ea5b25fdfa79ec1a10e747425f34e224bf00**, GitHub Actions pull_request run [41825029614](https://github.com/Naveax/Nexowire/actions/runs/41825029614), attempt 1, completed FAILURE. Runner head_sha matched this SHA. Node 24 job 126557460985, npm run check, **exit code 1**. Test fixtures compiled/ran; there is no invented local run.
- New real 307 collector: Agent authenticate **FAIL** (second server observed 1 redirected POST, expected 0); presence **FAIL** (1 redirected POST, expected 0). The initial run proves request forwarding, **not by itself that Authorization was retained**: browsers/fetch may strip cross-origin Authorization. A follow-up diagnostic collects only boolean indicators of device token in POST body, presence device ID, and Authorization header, without logging secrets. That diagnostic requires new exact-head CI.
- New Linux real filesystem: credential hardlink **FAIL**, writable parent **FAIL**, binary hardlink **FAIL**, credential symlink **PASS**. Each failed test lacked the named security-specific rejection, not because of an unrelated mock failure. Source baseline still insecure.
- Node 24 run also reported independent FAIL for existing OAuth public doctor and new V2-03 ingress query/Host/Origin test (socket closed, undici UND_ERR_SOCKET). These are separate owner regressions, not grounds to delete or skip V2-06 assertions.
- Windows browser-live job 126557461172, **exit code 1**: public OAuth doctor expected true but got false; disposable task parent termination failed. These were source-owner tests, not V2-06 fixture results.
- #1077 candidate 67fa411c6aa6135aeeac93f7197b5fd46c804884, CI run [41824607523](https://github.com/Naveax/Nexowire/actions/runs/41824607523), attempt 1: Linux Node 24 job 126556283541 showed original P1-A/B/D focused assertions **PASS**, plus Linux CLEAN-13 sealed-FD, symlink/hardlink, custody checks **PASS**. Original P1-C assertions remain **FAIL**. Windows browser-live job 126556283485 failed custody SID/ACE/parent, immutable native launch and task parent stop. Overall CI **FAIL**.
- #1074 candidate daa834ef588261905529c845d619c9df34b332f7, CI run [41825280799](https://github.com/Naveax/Nexowire/actions/runs/41825280799) was **in_progress** at this follow-up; do not rerun, do not imply all-green.
- **No combined #1077+#1074+current #1003 exact SHA acceptance was performed. Overall still NO-GO.** Source-owner PR heads are moving; re-read exact HEAD and base for any later gate.


## Additional V2-06 real HTTP/WSS authority oracle (candidate before CI)

- New test/v206-wss-authority-real-http.test.ts uses three genuine loopback TCP listeners: a disposable HTTP control-plane credential authority (not a mocked fetch), the actual Hub Agent WebSocket server with real AgentBroker and device-bound verifier, and the actual Cloudflare loopback origin bridge. No public tunnel or real user token.
- Negative #1: shared/wrong/expired credentials must receive HTTP 401 before HTTP 101; assert no unauthorized websocket or Agent registration and three actual control-plane requests.
- Negative #2: a syntactically valid token bound to one device cannot register a different Agent hello device (close code 1008, zero registration).
- Negative #3: revoke an open real-HTTP-verified device after precisely one native mutation dispatch; revalidation must close the socket and yield MUTATION_STATE_UNKNOWN with no replay. Verify empty WebSocket registry.
- Source-only and synthetic authorization policy: this does not prove live provider issuer/owner, production service token, offhost TLS/WSS or multi-host CAS. This is real TCP/HTTP/WS product-path negative evidence; additional V2-08 owner-epoch and physical acceptance remain NOT_RUN.
- **Status at authoring: NOT_RUN** for this new file until matching automatic exact-SHA CI finishes. No skip or weakened original assertions.


## Latest V2-06 exact-head CI results (2026-11-04)

Source SHA **84d66e964e319e6fbc1c9a747059c35dedc6fddf**. GitHub Actions [run 41826248796](https://github.com/Naveax/Nexowire/actions/runs/41826248796), attempt 1, completed **FAILURE**. Linux Node 24 job **126561611349**, command **npm run check**, exit code **1**. Windows browser-live job **126561611396**, exit code **1**. Node 22 job cancelled after security failures. Other jobs that succeeded do not override mandatory RED security cases.

| New isolated attack or verification | Result | Evidence on this exact SHA |
|---|---|---|
| P1-C real HTTP 307 Agent authentication redirect | FAIL | Second real localhost HTTP server received 1 request, **device credential present in redirected JSON body**, Authorization header **absent**. Fetch stripped Authorization, but not the device secret in POST JSON. |
| P1-C real HTTP 307 Agent presence redirect | FAIL | Second localhost HTTP server received 1 request, presence device ID present in redirected body, Authorization header absent. Secret-bearing requests must not redirect to another target. |
| P1-D Linux credential hardlink | FAIL | Actual filesystem link alias not denied with the required custody reason |
| P1-D Linux writable parent mode 0777 | FAIL | Actual chmod and file admission failed to reject parent custody violation |
| P1-A Linux executable hardlink | FAIL | Actual filesystem alias not rejected for binary identity |
| P1-D Linux credential symlink | PASS | Real symlink rejected before connector launch |
| WSS wrong/shared/expired credential before HTTP 101 | PASS | Real loopback HTTP authority, Hub and ingress origin; zero unauthorized WebSocket upgrades |
| WSS mismatched Agent hello device | PASS | Hub sends close 1008 and no Agent is registered under the wrong device |
| WSS open-session revoke after one mutation dispatch | PASS | Actual HTTP-bound Hub session, one files.write dispatch, revalidation closes WSS, MUTATION_STATE_UNKNOWN, **exactly one** dispatch, no automatic replay |

The WSS verification deliberately accelerates authorization revalidation to 250ms. It does **not** prove production 60-second behavior, immediate mutation dispatch-time revocation, real offhost HTTPS/WSS, issuer authenticity, owner enrollment or multi-host epoch CAS. The redirect fixture reports boolean secret-presence indicators without logging credential bytes. Original AI-11 P1-A/B/C/D source negatives remain RED on the unpatched #1003 stack.

### Independent sibling exact-SHA checks (not integrated)

- V2-01 / #1077 source **67fa411c6aa6135aeeac93f7197b5fd46c804884**: [CI 41824607523](https://github.com/Naveax/Nexowire/actions/runs/41824607523), Linux Node 24 job **126556283541**: original P1-A/B/D and CLEAN-13 Linux sealed-FD, symlink, hardlink and credential tests PASS; P1-C original admission and redirect negatives FAIL. Windows browser-live job **126556283485**: SID/ACE/parent custody, immutable-image launch and managed parent stop FAIL. Overall CI **FAIL**. Binary publisher preflight rejection alone is not trusted-image TOCTOU proof.
- V2-02 / #1074 source **5997a6d7ae43c34170016eb0963718ee35bf4a15**: [CI 41825684508](https://github.com/Naveax/Nexowire/actions/runs/41825684508), Linux Node 24 job **126559682459**: four secret POST redirect:error tests, real HTTP 301/302/307/308 no-forward collector, DNS rebinding/A/AAAA pin, Unicode and alternate IP tests PASS. Three original P1-C Cloudflare **publication boundary** negative tests FAIL. A distinct revoke-between-session-checks negative **FAILS**, proving an owner/device revoked before the next 60-second check may still dispatch a mutation. Overall CI **FAIL**.
- Parent #1003 new doctor at **95d9f9e431ad5a9c46adde1ecf716f84d60d8455** requires a 401 with matching WWW-Authenticate Bearer resource_metadata challenge before recording public OAuth boundary success. Legacy cloudflare-connection-lifecycle test fixture expects success for a bare 401, generating false !== true on #1044 Node 24 and Windows CI. This is fixture drift under a stricter security contract. Source-owner must update **its own test** to provide a correctly bound challenge and negative missing/wrong-challenge assertions; do not weaken product validation.

### Final acceptance and preservation

Original #1044 AI-11 test blobs were rechecked at the above SHA, all **byte-identical**:
- f74ee761bfe00ff304b8c6070a26654c7c481e88 (address and credential custody, 118 lines)
- d75ab8ddcc8ab887220bea203026f1ed98eb77a9 (path race, 95 lines)
- 963393d00cc3368b9c76a7d8e9bb8cd4e455b706 (connection v2 negative, 179 lines)

The owner branch diff from 4d8f215f36de7fe05e85a9c19fc40cc35716d705 contained only three added V2-06 fixture files and this evidence document: zero source-product edits and no changed original assertions.

**P1-A/B/C/D + hosted OAuth + offhost WSS + immediate revocation + Windows process tree: NO-GO.** Actual Windows Authenticode self-signed/wrong-publisher and reparse/SID/DACL/ACE physical negatives, offhost OAuth/WSS, dispatch-time epoch fence, both siblings integrated at a single source SHA, and physical two-PC reboot/credential revocation remain **NOT_RUN or FAIL**, not PASS. The V2-08 independent handoff is recorded in the #1044 PR Conversation and #1083. No production action, CORE, Cloudflare DNS/tunnel, live PCs, main merge, branch deletion or duplicate CI dispatch occurred.
