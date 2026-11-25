# Unique K03 Broker command progress regression port (2026-11-19)

Source: open PR #1103 (`4d581bef3ca0ca26f626d6ecd499832f0af10e2c`), `test/delegated/k03/bridge-command-progress.test.mjs` exact unchanged Git blob `76a5e4dc148cfe230ca94de0ee79cdedf67b078c`. The prior independent `console-grant-view.test.mjs` fixture already entered #1160 at `c6c4e4ec`.

The new source-only VM negative tests exercise six top-level cases: queued/claimed/applied only succeeds on matching final acknowledgement; failed/expired/unexpected terminal states; mismatched request/device IDs; wrong confirmation phrase; HTTP 401/503 poll responses and restoring controls; and malformed issue receipts. No real Hub, Agent, Broker, Windows session or remote device is touched. `web/app.js` production logic is not modified.

Hosted CI Linux Node 22/24 now executes BOTH exact K03 fixture paths under a single explicit TAP lane with zero fail/skip/todo and a 10-test minimum count. This does NOT assert full `npm test` discovery (#1205) or physical device authorization. Both #1103 original source files are now source-ported, but that historical PR still must not be described as GitHub-merged merely because these bytes are included in an integration candidate.

Provenance dependency DAG updated from GitHub-generated blob IDs:
- CI `aba3bf105789e1b9e0c6e666849de8f6740ecda3` -> `99c3f82f446fce0694a6cd5a22161b9b559f67ff`
- Connection v2 matrix `5554a46353363ec2b08723b2ace2fefbc8005a9c` -> `b26d6d58b26611241d78094cafbf457730960236`
- AI05 CORE/Connection matrix `7111249764d1b27c0272c3cf301cc4c5a844715b` -> `c44904a74d04d64af79c21c032c62c11f27786c5`
- Round2 matrix current `74cea1c12bbccce95f6c0e8c9cd7c5fd3018298d` -> `18e6c4b2928ae46a9a9e00a5504b0b8738dd0b19`

Original source blob fields, row counts, and semantic-review classifications retained.
