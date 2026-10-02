# Quota identity and device binding

Nexowire does not use email addresses as quota identities.

## Identity layers

Authentication identities such as GitHub, Google, or email map to an account. Each account maps to a separate quota subject.

A new Free account receives its own `free-cluster` quota subject. When a Nexowire Agent pairs a device, it supplies only a SHA-256 device-anchor digest. If that digest already belongs to another Free quota subject, the two Free subjects are merged.

This means changing an email address does not reset usage, and creating a second login on the same Nexowire device does not create a second Free allowance.

## Device anchor privacy

The Agent generates a random 256-bit device anchor locally.

On Windows:
- the raw anchor is stored with CurrentUser DPAPI;
- the raw value is never sent to the control plane;
- only a domain-separated SHA-256 digest is transmitted;
- motherboard serials, disk serials, MAC addresses, CPU IDs, and browser fingerprinting are not used.

Removing the Windows profile or secure storage can remove the anchor. The device anchor is therefore an anti-abuse signal, not a claim of perfect physical-device identity.

## Free quota merge

If two Free subjects become linked by one device anchor:
- accounts are moved to one canonical quota subject;
- device-anchor mappings move to the same subject;
- existing usage periods are summed;
- event IDs are migrated for idempotency;
- migrated events are marked so usage is not applied a second time;
- future calls share the same remaining Free quota.

The merge intentionally preserves already-consumed credits. A new login cannot make prior usage disappear.

## Paid plans

A paid subscription should receive its own subscription quota subject. Device anchors remain useful for anti-abuse and account recovery signals, but a paid subscription's purchased quota must not be silently merged into a Free cluster.

Plan transition logic will explicitly create or reattach quota subjects when subscription billing is implemented.

## Data minimization

The control plane stores:
- account and external-login identifiers;
- quota subject identifiers;
- device anchor hashes;
- plan and aggregate usage metadata;
- short-lived pairing metadata.

It does not persist screenshots, clipboard contents, terminal streams, transferred files, or private-screen frames. Data-plane payloads should be streamed and discarded after delivery.
