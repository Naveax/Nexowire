# S2 Windows CNG key provider and signed P-256 migration: acceptance ledger

Date: 2026-10-19. Source base: Naveax/Nexowire main cb819d17ee581093d39626f13e985976def17f30 at initial worktree creation.

**PRODUCTION NO-GO.** This is a separate source-only proposal, not a rollout, key conversion, production account/device enrollment or native Broker admission. Existing merged PR #537/#546/#568 signed WSS v1 and revocation logic are not modified.

## Real two-device provider inventory

Work PC Windows NT 10.0.19045, Naveax Windows NT 10.0.22631. On both physical Windows machines a read-only NCryptOpenStorageProvider / NCryptIsAlgSupported probe was executed against Microsoft Software Key Storage Provider and Microsoft Platform Crypto Provider. Results were the same:

- ED25519: status 0x80090029 on BOTH providers (not supported).
- ECDSA_P256: status 0x00000000 on BOTH providers (algorithm accepted).
- RSA: status 0x00000000 on BOTH providers.
- Both storage providers opened with status 0x00000000.

On both devices, **disposable, unnamed, test-only** ECDSA P-256 keys were created with CngExportPolicies.None, tested with signature/verification, and attempts to export the private blob threw CryptographicException. All managed key handles were disposed in finally. These tests did not enroll any production device or use Agent credentials. Critically, CngKey.IsEphemeral reported **False** on both machines, despite null key names, and durable key lifetime/cleanup was not independently attested; this ambiguity is a release blocker, not a claim of persistence or successful erasure.

TPM Get-Tpm property queries were empty and Work PC Win32_Tpm CIM query errored. Thus actual TPM availability/readiness, long-lived KSP key persistence, hardware identity, export-policy enforcement across process/user boundaries and machine/reboot survival are NOT PROVEN. Algorithm support or a disposable negative export test is not a production key acceptance.

The repository includes a repeatable READ-ONLY inventory script: scripts/inspect-s2-cng-algorithms-readonly.ps1. It does not create any keys and always outputs productionAccepted:false.

## Security contract introduced

- src/product/owner-public-wss-p256-migration-proposal.ts implements a staging-only, version 2 domain-separated migration verification contract. It binds account, device, operator/key IDs, trusted owner session generation, an exact migration epoch, the original Ed25519 SPKI SHA-256, the next ECDSA P-256 SPKI SHA-256, issuance/expiry and separate signatures.
- New P-256 public key signs a canonical possession proof; the original operator-controlled Ed25519 key signs the complete migration approval including the new public key and possession signature.
- Trusted authority/context is provided independently and must require version 2; v1 payloads, alternate algorithms, incorrect curve, wrong owner/device, stale epoch/session, expired issuance, wrong SPKI or signatures fail closed.
- A successful synthetic verification returns nativeBrokerAuthorized:false and productionAccepted:false, and cannot update any account, key store, live session or enrollment.
- This code deliberately does NOT silently replace the current Ed25519 WSS signing algorithm, does NOT assume CNG/TPM key identity from a PEM or self-claimed property, and does NOT wire a native operation to quota reservation.

## Real owner OAuth, Named Cloudflare Tunnel and Broker

- Deployed Nexowire Agents observed online at version 1.0.5. Work PC scheduled task: Native Agent Running as local user at Limited runlevel, privileged broker Running as the same local user at Highest runlevel; Hub task Disabled. Naveax Agent Running under its local user, privileged broker and Stack tasks running at Highest runlevel. These are scheduled tasks, NOT proof of a separate service account.
- Separate Windows-user access denial, account switching, LocalSystem/service SID binding, and actual Agent restart with continued key use were NOT tested; no user passwords, UAC or production process restarts attempted.
- No authenticated real owner OAuth issuer, production operator-signed enrollment receipt, dynamic server-side revocation propagation, or native Broker grant revocation was available for acceptance. Earlier synthetic account/session/nonce tests remain staging evidence only.
- No independently verified Cloudflare account/zone/Named Tunnel/domain was provided. On both checked users, cloudflared was not found on PATH and no user cloudflared config directory was identified; this alone does not prove no Cloudflare account exists. No DNS, API token, tunnel, public hostname, TLS connection or live ingress was created or modified. Prior Quick Tunnel evidence remains explicitly non-production.
- Current strict SPKI-pinned public WSS handshake requires a reviewed operator-controlled edge certificate/key rotation or independently provisioned trust migration before any named-host cutover.

## Gate matrix

| Gate | Observed | Production result |
| --- | --- | --- |
| Native provider algorithm inventory | Two physical computers, both KSPs, ECDSA_P256 yes / ED25519 no | SOURCE/PHYSICAL PRECHECK ONLY |
| Ephemeral P-256 signature and private export rejection | Both devices, CngExportPolicies.None, dispose in finally; IsEphemeral=False inconsistency | BLOCKED |
| Non-exportable persisted device key across restart/other user | No persisted enrollment key or different-user test | NOT_TESTED |
| Device service account binding and Agent restart | Read-only task identity; no reboot/restart/mutation | NOT_TESTED |
| Versioned signed P256 migration | Synthetic operator and device proof + negative tests | STAGING ONLY |
| Ed25519 v1 WSS revoke/replay/lease | Covered by merged #537/#546/#568, not rewritten | STAGING ONLY |
| Real owner OAuth/issuer/owner-device binding | No authenticated production issuer/receipt verified | BLOCKED |
| Named Cloudflare Tunnel, exact hostname/SNI/SAN/TLS and cert rotation | No authenticated owned zone/domain or named tunnel access | BLOCKED |
| Native Broker execution and in-flight revoke | No verified authority boundary; deliberately not wired | BLOCKED |

## Production promotion requirements

1. Obtain operator-authorized ownership of a real Cloudflare account/zone/tunnel and issuer, use READ-ONLY inspection first, and prove exact hostname/ingress/TLS identity with independent trust.
2. Independently verify a persisted, non-exportable native key bound to the expected OS account/service identity; test ACL, a second Windows principal, restart/reboot, rotation, revocation and rollback without exposing raw private material.
3. Approve a versioned P-256 migration including trusted minimum protocol version, anti-downgrade state, issuer key rotation and server-side acceptance implementation. An offline signed proposal is insufficient.
4. Confirm production issuer/session generation and revoke propagation while a native operation is pending, separately from the quota reservation. Never treat quota reserved as authorization to run Broker tools.
5. Repeat true external-ISP public WSS tests with reconnect, lost ACK, stale nonce, key rollover and rollback, with independent timestamps/audit logs.

No production changes were made by this worktree. All credentials and test signing keypairs in source tests are generated within the test process.
