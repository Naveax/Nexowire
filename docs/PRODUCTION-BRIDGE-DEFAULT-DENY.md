# Production Worker: explicit Admin Bridge command default-deny

The owner dashboard may save Admin Bridge AUTO / ON / OFF preferences without granting operating-system privilege. The command endpoints introduced for future Guardian transport are deliberately not enabled in the live production Worker.

The Worker now passes an **explicit, source-pinned false** `PRODUCTION_BRIDGE_COMMAND_TRANSPORT_ENABLED` to the command handler. It does not read an environment flag, an owner preference, a bearer token or a remote request field to override this gate. The HTTP handler also independently requires an injected trusted per-device Guardian public-key resolver, so a future accidental boolean flip cannot alone activate the routes.

This is a defense-in-depth assertion of the existing closed behavior. Tests inspect the production assembly and the HTTP double gate. **No production Worker has been redeployed.** The UI source controls are still preference-only until all of the following are independently accepted: P0 #271 executable integrity cutover, owner-approved protected separate Guardian, authenticated Hub transport, trusted device signing-key enrollment, durable replay defense and local observed task postconditions.

This PR contains no D1 migration, live OS task action or deployment trigger.
