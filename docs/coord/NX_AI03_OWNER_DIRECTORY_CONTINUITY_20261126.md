# AI-03 independent owner registration and restore continuity review

Base: bca238ef4bf681da7b5bc27b79adf07f2cf2fdf4, exact coordinator candidate. #1329/#1365 source selection, #402 and native MSVC acceptance remain coordinator-owned. No changes to existing issuer/launcher/approval ledger, pendingDispatch, native proof, D1 CAS, shared pins, runtime composition or CORE dispatch flag.

## Actual gap

The existing Windows provider generates a fresh enrollment UUID and Ed25519 issuer key at enrollment; protected consent authority requires an independently provisioned matching binding, authenticator and issuer pin. There is no approved independent registration writer or directory continuity service. The PostgreSQL approval runtime explicitly denies provisioning privileges and consumes only existing approved bindings/credentials. Do not widen that role or copy caller challenge into the directory. No existing verifier or new read-only review can establish a physical approval or authorize an OS effect.

## Delivered component

src/security/owner-directory-continuity-review.ts is a read-only, explicitly non-authorizing preflight for independently supplied registration and continuity evidence. It does not return a NativeCoreConsentProof, binding for runtime authority, or registration permission. Output is REVIEW_MATCH, generation, restore epoch, digest, coreAuthority:false, physicalAcceptance:NOT_PROVEN. It is not mounted in runtime. Both readers are mandatory; both public SPKI keys are independently pinned and distinct. There is no local signer, private key field, default endpoint, generated directory record, fallback, or registration API.

Each read gets only a protected, preconfigured owner/device/installation scope, authority ID, directory ID and fresh random nonce. It does not get an Agent-supplied enrollment, public key, generation or digest. Registration source must read its own latest approved record; continuity source must independently read its own durable latest generation, restore epoch and state hash. Never issue continuity evidence by echoing a supplied directory digest.

The two envelopes are canonical base64url payload bytes and 64-byte Ed25519 signature. Signature covers UTF-8 domain followed by NUL followed by original payload bytes. Domains are nexowire.owner-directory.registration.v1 and nexowire.owner-directory.continuity.v1. Strict schema, nonce, authority, directory, configured scope, freshness and monotonic deadline are verified. The registration state digest is SHA256 of UTF-8 JSON of validated registration excluding nonce and observedAtMs, recursively sorting object keys lexicographically, preserving array order and JSON primitive encoding. Witness matches generation, restore epoch and exact state digest. Process-local watermark denies generation decrease and same-generation equivocation. This is supplementary only. It cannot detect rollback of both trusted sources, nor replace independent durable continuity across process restart. A fresh reviewer still depends on an independently non-restored latest witness. No positive permission is inferred from a match.

## External prerequisites and composition decisions

| Gate | Required independently supplied evidence | Current status |
|---|---|---|
| Initial registration | Authorized operator's independent owner/device/install enrollment decision and actual approved public-key/authenticator registration; no Agent self-assertion | BLOCKED |
| Directory | Protected independent owner directory service with immutable history, monotonic generations, exact credential and issuer pin, denied runtime write access | BLOCKED |
| Restore continuity | Separate trust domain and separately controlled signing key, independent durable latest state outside restorable directory, fail-closed after inconsistent restore | BLOCKED |
| Owner issuer | Reviewed #1329/#1365, signed installed native component, actual SYSTEM/Session0 and independent owner binding, physical ceremony | BLOCKED |
| Canonical service composition | Independently reviewed and installed real sources, exact pin/role provenance, no test callback; existing protected issuer remains separate from Agent/hosted verifier | BLOCKED |
| Hosted verifier | Existing handler and restricted durable ledger, independently authorized mTLS principal and protected external signer; Cloudflare Worker currently lacks actual native verifier binding | BLOCKED |
| Native execution | CORE hard stop, independent capability and OS evidence acceptance | BLOCKED |

A registration change must be externally authorized and independently durable before runtime can consume it. Monotonic generation and restore continuity must cover every change to the approved binding, issuer and credential. The independent authority must retain history across reboot, restore and ACK loss; an unknown or stale state cannot be used to create another enrollment automatically. Do not assume this preflight implements such a writer or proves custody. Physical owner consent is a separate decision, never an output of registration, WTS state, a valid signature or a test key. AI-02 recovery remains a distinct trust root; directory review cannot grant rollback or drain.

No live setup is authorized. Before composition, require actual independently provisioned service identities, signer custody, scope and restore acceptance, independent #402 and Windows native build review, operator-approved isolated Windows ceremony and hosted verifier acceptance. No secrets or private keys are to be included in repo/CI. The read-only audit alone cannot enable the existing issuer/hosted verifier or lift any production deny.

## Acceptance

Five tests cover matching read-only result, fresh reviewer against restored directory, process-local generation rewind/equivocation, replay/wrong signature/wrong scope/shared signer/private key/noncanonical credential, unavailable/cancelled witness. Synthetic keys only; exact hosted execution pending. No test is physical acceptance.
