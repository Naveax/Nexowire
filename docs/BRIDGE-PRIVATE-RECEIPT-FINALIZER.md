# Private finalization of Guardian-signed Bridge receipts

The signed-receipt HTTP handler already checks current pairing, current owner preference, canonical Ed25519 signature, timing, Broker health schema and atomic durable completion. One unsafe extension point remained: the lower-level `completeBridgeModeCommand` method was callable outside `ControlPlaneService` without a cryptographic envelope.

The finalizer is now an ECMAScript **private** class method (`#completeBridgeModeCommand`), invoked exclusively *after* the public `completeSignedBridgeModeCommand` successfully verifies the registered Guardian signing key and exact immutable receipt transcript. Other code cannot directly call the unsiged lower-level method. Previously direct tests of finalization now use a valid synthetic signed receipt instead.

This does not create or install a protected Guardian, enroll a real signing key, enable network command transport or actuate Windows tasks. It does not claim a signed self-report independently proves actual OS state. Real trusted local task measurements, Guardian recovery independent of the Broker, owner-approved key enrollment and P0 #271 secure cutover remain mandatory before production commands.

The production Worker continues to leave the Bridge command transport disabled. No D1 migration, protected process, live ACL or scheduled-task change is performed by this PR.
