# Nexowire cross-project main integration and release gates — 2026-10-20

**Integration-only snapshot.** Repository `Naveax/Nexowire`. Verified source baseline `main`: `63482b2e25e66be6d2edda4dfb4f4f868e5d012a`. This file is not a live status feed. Re-read PR HEAD, diff, review threads, exact-head workflows and current main immediately before every merge. Only this integration chat merges main. No developer worktree or installed Nexowire Agent/Hub/Broker was changed. Work PC and Naveax both advertised Agent **1.0.5**.

## 2026-10-20 merged source evidence

| PR | Source merge commit | Independent local regression after merge | Staging | Production | Original incident |
|---|---|---|---|---|---|
| #584 Artifact Bridge one-descriptor read integrity | `618d1922aa34fa0ac7b571917652143fea87195d` | 31/31 PASS | NO | NO | OPEN |
| #580 connection-bound Journal reconciliation | `4d8bb072a01981be525fd7d0f800c0e2a62332f7` | 18/18 PASS | NO | NO | OPEN |
| #581 read-only D1 staging preflight | `21cca4f281548df1fbc0a27638727dda424e2e11` | 21/21 PASS | NO (missing real credentials) | NO | OPEN |
| #583 S5 WSS and provider-meter refusal | `6570ddf6f6fd6bdcd1e6ece08ae842380644a465` | 14/14 PASS | NO (no hosted sessions) | NO | OPEN |
| #585 CNG P-256 migration proposal | `af0e0e6149be696837038875f463d23af59b80c6` | 12/12 PASS | NO | NO | OPEN |
| #579 UIA helper hash + owned Edge cleanup | `63482b2e25e66be6d2edda4dfb4f4f868e5d012a` | 7/7 PASS on main; independent live Work PC 11/11 | NO | NO | OPEN |
| #586 Windows Job portable SHA audit **child** | `e348fac7b3815ce2c0b4a26030e3adcaa5e2bd1c` into parent #576 ONLY | 17/18 PASS, 1 permission skip on parent/main preview | NO | NO | OPEN |

The first six PRs had confirmed completed-success exact-head CI before source merge, and the full combined five-PR preview had typecheck/build + **69/69** tests PASS. #586 had seven successful CI jobs at exact child SHA `2391bbe0d02430d126183b4a90d65a786e4926df`. The child's seven extra QA files were byte-identical to already-merged main files; parent branch CI must be repeated at the **new parent HEAD**.

## Pending intake and exact-head gates (snapshot)

| PR | Latest observed HEAD | Observed CI/run | Source merge gate | Staging | Production | Incident |
|---|---|---|---|---|---|---|
| #576 WinJob trust | `5fdae89bf1f0440995e61f8dbfc22524a616c63e` | `39412019817`, `39412019534` in progress | HOLD; parent after child #586; independent trusted publisher/ACL and DUP_HANDLE audit | NO | NO | OPEN |
| #582 Journal anti-rollback | `ccae784632c080ae52c0ccc0de3933f875162a42` | `39282872126` FAILED | P0 #587 co-rollback: NO-GO; DO NOT merge | NO | NO | OPEN |
| #553 USB/scoped path | `ba3bb52dc9fc7ad7fc8e3a22dd766623218cae63` | `39282648539` SUCCESS | physical authenticated console grant, junction/reparse/handle TOCTOU and hotplug missing | NO | NO | OPEN |
| #551 lifecycle installer | `328efa82d0b244a62b3ecd36dbea5ddefeebaa15` | `39283475846`, `39283475737` SUCCESS | no trusted signed installer and physical canary/rollback | NO | NO | OPEN |
| #574 ROOT Guardian | `0a64f7068e16701bd3006d35c361d5d10c1fe17b` | `39411740328` SUCCESS | Broker ACL and independent Guardian physical proof missing | NO | NO | OPEN |
| #575 progress proof | `45cc829896668884f70c84304e6cfb8f0bf6b627` | `39283737901`, `39283737780` SUCCESS | producer-controlled receipts are not trusted completion evidence | NO | NO | OPEN |
| #565 error chain | `75abbd7d3cd17ca10e8c16e70081161428cc2078` | `39412566535` in progress | HOLD pending exact-head all-green + independent attribution checks | NO | NO | OPEN |
| #572 independent QA | `6b3d7eddcab9951dd35c9bd190cc7b61a1d078c8` | `39284185988` FAILED | HOLD and preserve failing negative tests | NO | NO | OPEN |
| #589 chunk reconnect fixtures | `28ef776305ff3d3f4094787e9acb65155e2fddef` | `39412171648` in progress | Independent Work PC localhost 512KiB+ failover 9/9 PASS; HOLD CI | NO | NO | OPEN |
| #480 obsolete GUI broker | `ec3c54d77e3b9fabb4c85831222fb48b112cd7b2` | historical SUCCESS | DO NOT remerge after #570; it conflicts in shared broker guard | NO | NO | OPEN |

## P0 release refusal

1. **#587 — joint journal/authority rollback:** both SQLite databases and WAL restored together re-admit old request ID (`created:true`). A second restorable SQLite file is not a monotonic authority. Need rollback-independent authenticated reservation/CAS (or validated hardware root), offline fail-closed, signed identity, migration and synthetic plus physical co-rollback tests. #582 fails CI and is production **NO-GO** regardless.
2. **#576/#541 — trusted Job helper:** independent pinned publisher/signature, release manifest, hardened installation ACL, image identity and process handle integrity, hostile nested Jobs, guard against PROCESS_DUP_HANDLE, real Agent rollback. An unsigned EXE with a replaceable SHA-256 sidecar is not trusted production evidence.
3. **#553/R05 — filesystem/USB:** owner-console grant, reparse/junction race-resistant handle policy, physical USB removal/letter changes, EACCES and revoke tests. Synthetic green CI is not physical acceptance.
4. **#574/Guardian:** original Broker ACL where Authenticated Users can modify trusted executables, missing independent authority and live OFF/ON recovery, signed migration. Do not enable ROOT/CORE.
5. **#551 updater:** no vendor-trusted Authenticode chain, verified reversible native installer or successful physical two-device canary. Keep Agent 1.0.5 until separately authorized.
6. **#579/#402:** hash checks detect persisted script replacement but not pre-execution TOCTOU, COM/native/UAC escape or production owner UIA, so original incident remains open.
7. **#575/R18:** worker-writable manifests cannot themselves prove exit status or accepted completed work. Independent protected producer/root evidence and original workflow replay required.

## Large files (#588) owners and scope

- **Chat #05 / PR #553 File/USB** owns authorised Agent chunk read/write/hash, offset >`268435456` (currently capped in both `src/agent/executors.ts` and `src/mcp/create-server.ts`), volume and path scope, cancellation, sparse-file/reparse race and revoke; keep per-message payload bounded.
- **Chat #08 / merged #584 Artifact Bridge** owns v2 manifest, externalized chunk metadata, durable resume offset CAS, streaming verified SHA256, device ingest/egress and account/project/device storage quotas. Current `src/mcp/artifact-bridge-device-ingest.ts` caps source at 256 MiB, `src/workspace/artifact-bridge.ts` caps manifest size at 256 MiB and session chunk count at 4096 of 64 KiB. A single response cannot be unlimited.
- **Chat #06 / PR #589** has a localhost 512 KiB+37-byte fault-injection fixture: stale response denied, interrupted after 262144 bytes and resumed exact offset, independent full SHA-256, 9/9 preview PASS. This is **not** proof of >256 MiB support or WAN upload.
- Independent **Chat #16 QA** must test 221 KiB, 256 MiB+1, 1 GiB (when disk permits), sparse >4 GiB offsets, reboot/resume, original file replacement, wrong owner/device/project, source mutation, low disk, duplicate chunks, cancellation, quotas, retention and exact CI head. No promise of mathematically infinite storage.

**Platform/UI distinction:** The user's reported approximately 220 KB ceiling has not been positively attributed to the source; ChatGPT/provider message framing might have a separate cap. Never claim native backend changes remove platform-owned limits.

### Merge discipline

Keep developer branches/worktrees isolated. Follow existing queued/in-progress workflows without duplicate triggers for identical SHA/workflow/inputs. Merge only exact-head CI green + current-main no conflicts + independent diff/security review and regression on merged main. Separate statuses for source tested, staging accepted, production deployed and original incident closed. Never change live Agent, Hub, Broker, Cloudflare, DNS, real quota or billing through this integration ledger.
