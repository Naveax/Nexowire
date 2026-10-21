# P0 #617 / #323: Hyper-V Admin Bridge local consent authority

Date: 2026-10-21. Ownership: #04 Access Control, PR #574 DRAFT.
Cross-reference: #618 Windows/Hyper-V source-only read-only contract;
#260 Broker version, #271 ACL trust, #551 signed installer, #587
independent replay authority. **Production NO-GO.**

## Observed read-only reality (NOT execution evidence)

Naveax `shell.exec` reported Medium integrity `S-1-16-8192`,
Administrators **deny-only**, running `vmms`/`vmcompute`, and
`Get-VM` `VirtualizationException`. An unauthenticated request to
Broker loopback 43112 `/health` returned HTTP 401. None establish
elevated Windows token identity, Broker authenticated handshake,
capability authorization, VM existence/identity, or installed Guardian.
ROOT 15-minute policy, persistent CORE preference and FULL access are
not Windows admin tokens. A prior UAC/transport UNKNOWN cannot be
described as a rejected or completed VM operation, nor replayed.

## Read-only local approval protocol design (not deployed)

1. An authenticated owner chooses a concrete action: `hyperv.vm.start`
   or `hyperv.vm.stop`, exact immutable canonical lowercase VM GUID,
   current paired device, owner account, request UUID, and independently
   approved policy SHA256. Display name is not an authorization target.
2. A separately installed **protected local Guardian** verifies the
   paired owner and current session epoch, policy revision, machine
   identity, exact VM GUID and native OS ability to request the action.
   It must use an independently pinned signing identity, not a key
   supplied with the request. No arbitrary elevated `shell.exec`.
3. The actual Windows machine shows a local **visible** confirmation,
   subject to normal OS/UAC secure desktop. The cloud UI and Agent must
   not click, simulate, suppress, or infer that approval. Explicit denial
   or no proof stops the request. A remote signed text claim
   `claimedLocalConsent` is NOT independent UAC evidence.
4. A locally signed bounded (<=60s) Ed25519 receipt binds the exact
   request, owner ID, paired device ID, VM GUID, Hyper-V capability,
   owner policy digest, current device credential digest, expected
   Broker version, actual local user SID, random 32-byte nonce and
   issued/expiration timestamps. A server verifier checks those
   values, a separately registered public key and durable one-shot
   request reservation. The receipt validates transcript integrity
   only, not physical UAC or helper origin.
5. **Separately before any native actuation**, trust must verify:
   - Native *enabled* admin token/high integrity, not Medium/deny-only
   - Protected source parent/updater/Broker/Guardian/helper ACL and
     exact signed release + in-memory process identity from #271/#551
   - Broker authenticated health, exact expected signed version from #260,
     and capability allowlist. HTTP 401 is **not** a valid proof
   - Independently authenticated Guardian and local consent from the
     actual console/secure UAC flow; no remote UAC bypass
   - Exact VM ID/owner/device allowlist, signed local approval,
     current owner session, independent provider policy and durable
     idempotency/replay authority (#587)
6. The trusted native executor, if separately authorized in a future
   release, must reserve the action one time and use explicit fixed
   hypervisor operations scoped to the VM GUID. No command-line
   string interpolation based on VM names.
7. After any possible dispatch, disconnect/timeout/ACK without
   independent trusted `Get-VM -Id` readback is
   `MUTATION_STATE_UNKNOWN`. **Do not auto-retry**. A verified
   outcome must be grounded in actual VM identity/state (and epoch),
   not Broker health or a signed self-claim.

## This PR's strictly bounded implementation

- `src/security/hyperv-local-approval-authority.ts` supplies only
  pure, schema-validated Ed25519 transcript verification and
  fail-closed source fact explanation. Even on a perfectly valid signed
  fixture it returns `physicalUacVerified:false`,
  `WindowsTokenAttested:false`,
  `productionExecutionAllowed:false`. Even all asserted flags
  result in `CANDIDATE_ONLY`, `canExecute:false`,
  `effectVerified:false`.
- `test/hyperv-local-approval-authority.test.ts` covers forged/wrong
  owner, device, immutable VM ID, operation, policy SHA, credential,
  version, local SID, key rotation, nonce, consent, expiry, replay,
  medium token, 401 health, unsigned Broker version/ACL and
  post-dispatch UNKNOWN no replay.
- `web/app.js` displays an explicit Windows/Hyper-V truth banner
  under Admin Bridge preferences. It never claims UAC granted,
  automatically clicks a consent dialog or operates a VM.
- This does **not** integrate the proposed signature with a live key
  registry, perform a native AuthzAccessCheck, test a local secure
  desktop, install a signed privileged helper, or deploy the
  independent Guardian. #618 remains read-only and DRAFT.

## Real physical acceptance matrix

| Gate | Result |
| --- | --- |
| Naveax Medium SID S-1-16-8192, admin deny-only | NON-ELEVATED |
| vmms/vmcompute Running | Service presence only |
| Get-VM VirtualizationException | No VM ownership/visibility proof |
| Broker loopback 43112 unauth /health 401 | Unauthenticated, no health/elevation proof |
| Naveax NexowireStack/cli.js inherited AU Modify | P0 UNSAFE #271 |
| Protected Broker ACL AccessDenied | UNKNOWN, not approved |
| Signed UAC-visible local approval | NOT TESTED |
| Independently protected Guardian/key registry | NOT ATTESTED |
| Exact VM GUID on physical device and policy ownership | NOT ATTESTED |
| Authenticated signed Broker version/OS token | NOT ATTESTED |
| Physical VM action and independent Get-VM -Id readback | NOT TESTED |

**NO-GO** until all independent physical gates are proven. No live UAC,
ACL, service, VM, Guardian or production Broker mutation was performed.
PR #574 remains DRAFT; no merge.
