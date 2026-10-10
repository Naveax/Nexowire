# Owner-visible Bridge command expiration (read-only status projection)

Admin Bridge commands have an enforced maximum **120-second** validity period. Their durable rows retain `queued` or `claimed` after expiry for audit/replay evidence, while DB claim/complete operations already prevent old commands from executing or being marked successful.

Previously `bridgeCommandStatus` could still return `queued` or `claimed` indefinitely after this TTL. That makes the owner-facing status misleading, particularly for long-disconnected machines.

The owner-only status endpoint now projects either pending state to `expired` when the authoritative service clock reaches the command expiry. It **does not alter** the database row and **does not** retry, reissue, actuate or convert any user preference to a command. Terminal `applied` and `failed` remain visible in their original state even after expiry, preserving history.

The HTTP command routes remain default-disabled in the production Worker; no deployed runtime, Broker task or native Agent changes are introduced. Focused tests assert exact TTL boundary, one-time claim semantics, and post-expiry preservation of terminal history.
