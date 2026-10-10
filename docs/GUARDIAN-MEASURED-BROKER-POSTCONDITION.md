# Bridge Guardian: fail-closed post-transition OS evidence policy

The existing `reconcilePrivilegedBrokerMode` only verifies the Scheduled Task post-transition state and deliberately reports `brokerHealthVerified:false`. An elevated scheduler state is not independent proof of a healthy Broker (or its absence).

`measureGuardianBrokerPostcondition` adds a separate **post-transition read-only policy** for a future independently installed trusted Guardian. The caller supplies three independently authenticated, local-only readers:

- Exact `Nexowire Privileged Broker` Task Scheduler identity/status and protected principal/action integrity.
- Current Windows process / TCP listener inventory, taken by a trusted privileged local collector and pinned to port **43112**.
- Authenticated Broker health with exact expected version and confirmed elevation, using the protected token already supported by `probePrivilegedBrokerHealth`.

### Acceptance rules

- **ON:** task `Running`, exactly one trusted Broker process and one Broker listener, verified local process image/owner provenance, and cryptographically authenticated Broker health `READY`, elevated, reachable and expected version matching.
- **AUTO:** all ON checks **plus** a separately verified recovery trigger. Task state alone cannot attest that a future Broker crash will recover.
- **OFF:** task `Disabled` **and** independently completed process and port inventory confirming zero Broker processes and zero 43112 listeners. A refused health probe or missing auth token never counts as Broker absence.
- Missing tasks, untrusted audit, unknown state, stale intent, mismatched health, omitted process evidence and errors are never converted into `applied`. Failures yield a well-formed *failed* receipt for signing by a future protected Guardian.
- The receipt still needs owner-approved command, local privileged Guardian attestation, current pairing, per-device Ed25519 signing, transport verification and atomic finalization.

**Important:** the injected collectors in this source-only policy are not themselves secure attestations. An untrusted Hub or remote Agent can fabricate the input objects. **Do not connect these to remote JSON or permit this method to authorize task mutation.** Protected local Windows process readers and a separate Guardian service are required before any production receipt may represent real measurements.

This PR implements no task start/stop, no listener or process probe, no key enrollment and no Cloudflare deployment. P0 #271 continues to block actual Windows privilege control.
