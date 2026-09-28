---
name: remote-recovery
description: Recover safely when a remote provider disconnects or fails during an operation.
version: 0.1
requires: machine.snapshot
---

# Remote Recovery

1. Classify the interrupted operation as read-only, idempotent, or potentially mutating.
2. For read-only work, retry through another healthy provider.
3. For mutations with unknown completion state, verify current machine state before retrying.
4. Never blindly replay deletes, moves, installs, sends, or other non-idempotent operations.
5. Continue with the best healthy provider only after reconciliation.
6. Store the provider transition and verification result in the workspace checkpoint.
