# S2 owner WSS security and #588 large-file streaming acceptance

Date: 2026-10-20. PRODUCTION NO-GO. Independent source-only follow-up. PR #537/#546/#568 already merged. PR #585 source CI passed. Issue #588 and chat #08 retain ownership of real artifact store, manifest, Agent file I/O, Hub ingest/egress/commit and large-file workflow.

## Existing transport boundaries

- src/product/owner-quota-outbound-ws-proposal.ts implements quota WSS, NOT artifact streaming. Strict 16 KiB incoming and response payloads, max 16 clients and 16 pending per client. This PR does not change these existing protections.
- src/mcp/artifact-bridge-device-ingest.ts currently reads 64 KiB chunks and has 16 default / 32 maximum chunks per call. Existing durable store has a 256 MiB total-object ceiling; the real issue #588 must be handled by #08 and not this adapter.
- A ChatGPT client/provider-owned attachment limit is not removable through S2 code. No whole-file WebSocket frame, unlimited resident memory or unbounded output.

## Implemented only in isolated staging

1. src/product/owner-public-wss-stream-flow-proposal.ts: fake-wire-neutral transfer flow controller. Requires independent trusted owner/device/project/session scope, versioned grant, durable owner receipt, pinned source identity/digest and per-chunk digest; 64 KiB chunks, 128 KiB maximum pending WebSocket bufferedAmount, one in-flight chunk and 32 chunks per call (2 MiB). It has safe integer offsets without imposing a small global max file length. Actual authentication, commit/CAS, full-file verification and disk publishing belong to #08.
2. Lost/forged/delayed WSS ACK or transport error is UNKNOWN and auto replay is disabled. The next explicit invocation consults independently trusted durable owner receipt and resumes from the committed offset, never trusting caller-specified offset. Grant and receipt verified before and after sending, as well as again after an awaited source read.
3. Synthetic tests: 221 KiB (4 chunks), 1 MiB (16 chunks), 256 MiB+1 / 1 GiB tail, FULL VIRTUAL 1 GiB over 16,384 frames in 512 sequential calls; >4 GiB safe offsets. No 1 GiB RAM allocation or physical 1 GiB disk transfer. Negative tests for backpressure, wrong scope owner/device/project/session, independent identical path names in multiple projects, grant revocation, corrupted source/digest, truncated read, forged ACK, duplicate offset and racing producer CAS.
4. test/owner-public-wss-stream-wss-loopback.test.ts: real isolated TLS1.3 WSS bound to 127.0.0.1 with synthetic self-signed certificate and separate test-only binary codec. Four bounded wire frames send 221 KiB. Intentional application-visible ACK loss after server commit is recovered over another WSS connection from authoritative fixture receipt. Oversized frames rejected by WebSocket maxPayload and mismatched device scope rejected with no commit. This is not a deployed Hub/Agent stream. Cert/key fixture removed after testing.

## Physical acceptance classification

| Gate | Observed proof | Production decision |
| --- | --- | --- |
| Windows provider capability | Two Windows devices CNG Software/Platform KSP: ED25519 0x80090029, ECDSA_P256 0x00000000; #585 | Provider algorithm only; persistent TPM identity BLOCKED |
| Synthetic CNG ECDSA private export rejection | Two physical PCs, temporary keys with export restrictions; CngKey.IsEphemeral False ambiguity | Not hardware key proof |
| DPAPI CurrentUser at rest | #568 temporary physical fixture PASS, can decrypt into Node | Not TPM non-exportable |
| Signed P256 migration | #585 staged separate operator/device signatures and anti-downgrade | Real production issuer migration NOT TESTED |
| Second Windows user/service account | Deployed Agent 1.0.5 task under interactive user, no distinct service principal | NOT TESTED |
| Agent restart/reopen nonexportable key | Live Agent not restarted by authorization constraint | NOT TESTED |
| Signed enrollment and owner revocation | #537/#546/#568 simulated owner state, lease, key revoke suites | Production OAuth and native Broker revoke BLOCKED |
| Named Cloudflare Tunnel and domain | No verified operator account/zone/tunnel/hostname/ingress | BLOCKED |
| TLS1.3 hostname, SAN, SPKI rotation | Local synthetic TLS/WSS, no real named hostname | BLOCKED |
| WSS flow control and resume | Synthetic 1 GiB virtual + local TLS 1.3 WSS 221 KiB | STAGING PASS |
| Real large-file disk store end-to-end | #08 owns this | NOT TESTED |
| Native Broker tool authorization | Never granted by quota, transfer or signatures here | BLOCKED |

## Required production release evidence

- Operator-authorized, authenticated Cloudflare account/zone/named tunnel/hostname, DNS/ingress and independent TLS SAN/CA/SPKI rotation evidence. A Quick Tunnel is NOT acceptance.
- Persisted, non-exportable native device key under exact approved principal, denied to another Windows user and service account, survives restart, key rotation/revoke and rollback. Default tested KSPs do not support Ed25519; ECDSA P-256 needs an explicitly approved and deployed versioned migration.
- Real OAuth issuer binding account/device, signed operator enrollment, owner-driven revoke propagation and native Broker execution-grant check separate from quota/stream admission.
- #08 real disk/store CAS, quotas, path permissions, source identity and full hash, sparse/disk-full policy and atomic publish; #06 reconnect UNKNOWN and epoch, #16 independent acceptance.
- Authorized named-host TLS WSS and separate-ISP, 221 KiB, 256 MiB+1 and 1 GiB actual file transfer measurements, staging rollout signed installer/canary #551, recovery and rollback.

No live Agent/Broker restart, DNS, Cloudflare tokens, real OAuth mutations, public tunnel or artifact store changes. Production remains NO-GO.

## Read-only physical preflight, this run
- 2026-10-20 Work PC: Cloudflared not on current PATH, no current-user .cloudflared folder; this does not prove absence of operator Cloudflare accounts elsewhere.
- Work PC TPM Win32_Tpm CIM query unavailable; do not claim physical TPM or key attestation.
- Work PC Native Agent and elevated Privileged Broker scheduled tasks run under local interactive user, not verified isolated service principal. Neither task was stopped or restarted.
- Naveax repeated read-only query in this turn did not complete due remote safety gate; no fresh Naveax physical acceptance is asserted.
- Full virtual 1 GiB stream test processed 16,384 chunks in 512 calls; synthetic benchmark is not network or disk throughput.
