# Machine update: bounded official release downloads

The official Windows machine updater downloaded the checksum list, setup script and ZIP into memory using Response.arrayBuffer() with no per-asset byte limits. The release assets are fetched from GitHub and checked against the release checksum manifest, but hashing does not prevent an oversized or malformed HTTP body from consuming excessive memory before verification.

## Limits and streaming contract

- SHA256SUMS-Windows is limited to 128 KiB, Nexowire-Setup.cmd to 2 MiB, and the Nexowire-Windows-x64.zip compressed transfer to 256 MiB.
- The response Content-Length is checked for early rejection where present and valid. More importantly, the actual body is consumed in bounded chunks with a running byte counter, so missing or dishonestly small Content-Length headers cannot bypass the cap.
- On overflow, the response reader is cancelled and the update refuses the asset before SHA-256 checks or staging. Invalid budgets, missing response bodies and invalid chunks fail closed.
- Existing download timeout, official setup/build identity, SHA-256 verification and protected machine-update tree/runtime preflight remain enforced.

## Windows work-pc tests

23/23 tests passed, including streamed exact-limit acceptance, early Content-Length rejection, absent/incorrect Content-Length overflow, missing body, invalid maximum and existing isolated machine cutover task-plan and port/PID checks. TypeScript typecheck/build and diff check passed.

Official Windows v1.0.5 ZIP published asset size observed: 40,978,916 bytes, below the 256 MiB cap. This is a source-only asset intake control and not a live download, update, ACL modification or deployment.

## Limitations

The ZIP cap is on the compressed HTTP body only; a separate extraction preflight must bound uncompressed archive entries/count and reject archive redirection or decompression bombs. Checksums from the same release URL are not independent publisher authorization. P0 #271 remains open until full code signing/provenance, effective ordinary-token denied write, administrator-authorized isolated task/secret rollback and protected installed runtime are verified.