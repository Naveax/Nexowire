# P0 unified read-only release provenance + byte-integrity preflight

Tracking #271 (unsafe live runtime), #265 (Hub handoff) and #260 (privileged Broker).

The CLI scripts/preflight-pinned-candidate.ts runs the existing **full archive/extracted tree comparison** and the **strictly pinned GitHub SLSA attestation verifier** as one single read-only check. It also hashes/checks the extracted tree again after attestation network activity to detect ordinary changes during verification.

The operator must supply exact approved pins from an independently owner-controlled source. The script never infers trust pins from the same user-writable extracted directory, nor from mutable release tag metadata alone.

## Windows invocation

Run from a separately trusted repository checkout with Node.js and dependencies installed. A correctly signed GitHub CLI must exist at C:\Program Files\GitHub CLI\gh.exe (the Windows tool checks GitHub, Inc. Authenticode, trusted file/directory owners and no untrusted allow-write ACL grants).

    node --import tsx scripts/preflight-pinned-candidate.ts 'C:\path\nexowire-1.0.5.tgz' 'C:\path\SHA256SUMS' 'C:\path\extracted\package' 'v1.0.5' 'a75d0d6c040bae2cd7d259a49521f33d56656fa4' 'a5c42cd8e25b698d4e6dead4bb25102217362ca639e91040d55dec389bafc314' 'c99081a1c6bddc5d5faae567a545b7d332a9d2b827f03084ff131aad9288e649'

Inputs (ordered): absolute or local read-only tarball path, checksum file, already-extracted package root, exact release tag, exact source Git SHA-1, externally approved tarball SHA-256, externally approved compiled CLI SHA-256. The command does not extract packages or stage/execute code.

The two verifiers independently check:

- Exact archive bytes, version, package identity, CLI SHA-256 and SHA256SUMS text.
- Bounded tar structure and all extracted files, including duplicates, links, unsafe names, extra files and mutations during hash reads. Verify extracted tree digest once before and once after the network attestation.
- Strict GitHub repository, source tag/commit and signer workflow identity, SLSA predicate, OIDC issuer and GitHub-hosted runner. Windows also verifies the GitHub CLI binary's publisher and ACL preflight.
- Cross-verifier SHA-256 consistency across tarball, CLI, source/tag and both full-tree snapshots.

All matching records return status PINNED_SOURCE_AND_TREE_MATCHED and a single digest summary. The output cannot certify that the whole installed executable/import tree remains safe after this moment.

## Absolute safety boundary

The output deliberately includes these fields as **false**: codePublisherSignatureVerified, adminProtectedTreeVerified, unprivilegedWriteDenialVerified, productionRollbackRestorationTested, ownerCutoverAuthorized, safeToElevate, safeToCutover and productionModified.

A GitHub Actions provenance statement signed by GitHub is NOT an independent Nexowire Authenticode publisher signature. The script is not a privileged installer, rollback, task/secret restoration, code extraction tool, task registration or Hub/Broker migration. It cannot prove a user cannot swap code afterwards, protect parent paths, verify untracked native DLL imports or bypass the live legacy Highest Stack ACL weakness.

**Do not run live maintenance based solely on this command.** Issue #271 remains open until separately authenticated owner-approved privileged deployment, updater-safe protected ACLs, actual low-privileged write-denial proof on the installed code/dependencies and real protected SYSTEM task/OAuth/DPAPI restoration are accepted.

## Real local v1.0.5 acceptance, 2026-10-09

The official archive and extracted 431-file package on work-pc passed this combined verifier without modification. Expected SHA-256: archive a5c42cd8e25b698d4e6dead4bb25102217362ca639e91040d55dec389bafc314, CLI c99081a1c6bddc5d5faae567a545b7d332a9d2b827f03084ff131aad9288e649, full tree 4b579683f972ba1d11f195c59a8a9b9c360fcddc3758de1d9ec3082d389b38c6, source commit a75d0d6c040bae2cd7d259a49521f33d56656fa4. This does NOT update the live Naveax installation.
