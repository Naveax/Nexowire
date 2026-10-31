# AI-04 -> AI-05 / coordinator integration requests

1. AI-05 must call Broker effect admission at every actual irreversible Windows mutation, not only one outer executor admission; use a new stable operation UUID per effect. `src/agent/executors.ts` is owned by AI-05 and is NOT changed here.
2. Wire Broker independently authenticated one-use CAS/receipt verification. The local `verifyReceipt` contract requires exactly the frozen `signedPayloadUtf8` argument. A fixture verifier that returns true is prohibited in production.
3. Keep execution disabled until genuine OS kernel identity, Windows Job ownership/descendant handling, pre-seal/equal-HIGH handle duplication and revoke cleanup have independently checkable evidence. A provisional Job readback is a P0 blocker.
4. Coordinator owns workflow changes or real Windows CI probes. Please independently run the AI-04 negative tests and strict MSVC C4133 compilation checks without skip/fixture promotion.
