# Guardian receives only pinned-Hub-signed, one-time Bridge commands

The existing control-plane bridge command ledger authenticates Hub service + paired Agent, and the signed receipt protocol authenticates Guardian -> Hub outcomes. The reverse direction **Hub -> Guardian** also needs message authentication.

This source-only module adds a strict versioned `guardian.hub-bridge-command` envelope that covers the exact Admin Bridge v1 intent, current owner preference audit revision, expected protected Guardian signing-key identity, and Hub signer key fingerprint. The canonical ordered transcript is domain-separated and signed with Ed25519.

`verifyAndReserveGuardianHubCommand` requires:
- A Hub public key **pre-pinned by a trusted local installation**, never taken from the incoming envelope.
- Local device ID, owner ID, current credential binding, latest owner-preference revision and expected local Guardian key identity.
- Canonical request UUID, AUTO/ON/OFF mode, and at-most-120-second validity window with clock-skew bound.
- An **atomic durable** reservation callback that must independently re-check current pairing/owner preference/revocation inside its transaction and reject consumed request IDs even across restarts.

It returns `executionAuthorized:false` even after successful verification. A correct signature proves message authenticity **only**; it does not grant UAC rights, privilege, protected source integrity, identity attestation or successful Windows Scheduled Task action.

No Hub signing key is provisioned, no D1 signer enrollment performed, no local Guardian service installed, no remote command dispatch wired to the new protocol, and no Cloudflare Worker deployed. The production Worker command transport stays closed. Security issue #271 remains OPEN pending owner-approved safe legacy-Stack integrity remediation.
