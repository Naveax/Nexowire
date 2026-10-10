# Independent Bridge Guardian: fail-closed command acceptance

Tracking [#323](https://github.com/Naveax/Nexowire/issues/323) (Admin Bridge AUTO/ON/OFF), [#271](https://github.com/Naveax/Nexowire/issues/271) (live privileged source ACL risk).

## The critical lifecycle constraint

The existing `Nexowire Privileged Broker` Windows Scheduled Task uses an every-minute recovery trigger. A durable OFF must disable the task **before** stopping its current instance, otherwise the recovery trigger undoes OFF. Once OFF has stopped the Broker, however, that Broker cannot be the *only* recipient capable of processing a later ON request.

The eventual solution requires a distinct, always-available, narrowly privileged **Bridge Guardian** with its **own** protected executable, task identity, credential storage, authenticated Hub session, durable replay log and operational health checks. Guardian must not share a scheduled-task enable/disable lifecycle with the Broker. It must never execute arbitrary commands or blindly mirror saved UI preferences.

## Added source-only gate

`reserveVerifiedGuardianCommand` is a **pure policy preflight**: it never enables, starts, stops, installs or disables Windows tasks. The caller must obtain `BridgeGuardianTrustedFacts` via a trusted **local** verifier, not via user-supplied JSON, a web receipt, or a remote tool result.

It requires:
- Current paired device ID, owner ID, credential binding, strict owner-consent request ID and latest owner-preference *audit revision*.
- Canonical v1 AUTO/ON/OFF intent with strictly limited lifetime; current FULL-access Windows mode.
- Installed/online Guardian that remains reachable even with the Broker OFF.
- Independently verified protected Guardian executable tree, expected scheduled-task identity, elevated local token, authenticated Hub channel and current paired-device session.
- For starting/enabling Broker (ON/AUTO): independent verification of the Broker's expected task action and protected launcher ACL. OFF does not require a healthy Broker, supporting emergency containment.
- An **atomic persistent reservation** bound to request UUID, device ID, current pairing and preference revision. A stale, replayed, canceled, expired or re-paired intent must return false. A local in-memory Set is not sufficient in production.

The return value is deliberately marked `reserved-for-verified-local-processing`: it is **not** a privileged task handle, execution approval, or a successful machine-state acknowledgement.

## Production gates not implemented

1. **Trusted local state collector** independent of cloud/browsers: verify actual Guardian task action, signer/publisher, executable full dependency tree ACL, correct user principal and a protected secret. An object's `true` booleans are not attestations.
2. **Authenticated durable delivery**: currently the control-plane command routes are explicitly disabled. A production Guardian transport must be paired and bound to the current owner/device credential, enforce request specificity and reject replay after restart.
3. **Transactional reservation**: the callback passed to `reserveVerifiedGuardianCommand` must re-read pairing, owner preference revision, access mode and current consent *inside* its transaction, not simply store a request ID. Enforce no rollback to previously used IDs.
4. **Explicit local authority**: trusted interactive Administrator context or a separately installed, ACL-protected fixed-scope privileged service under an owner-approved installer. Do not self-elevate, silently schedule tasks or accept a remote shell payload.
5. **Actuation and postcondition**: after local authorization, only the canonical Broker task may be changed; OFF disables before stopping; ON/AUTO may enable/start only with intact protected sources; acknowledge with measured Broker health/absence through the authenticated signed device channel.
6. **Safe rollback**: maintenance backup and verified restore for legacy privileged Stack, Agent and DPAPI secrets, with a non-elevated denied-write probe and tested device reconnection. P0 #271 remains open until this is independently accepted.

No production Agent, Windows task, ACL, Cloudflare Worker, D1 database or Hub transport is changed by this PR. The tests only evaluate policy decisions against synthetic trusted-fact fixtures.
