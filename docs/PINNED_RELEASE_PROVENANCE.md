# Pinned GitHub release provenance preflight

P0: Issue #271. Hub handoff: #265. Broker: #260.

The read-only verifier scripts/verify-pinned-release-provenance.ts adds an explicit signer, workflow and source policy to the archive/tree byte-integrity checks in scripts/verify-release-tree.ts.

## Trust inputs

Supply these pins from an independently trusted, owner-approved release record:

1. Exact expected SHA-256 of the release .tgz artifact (64 lower-case hex digits).
2. Exact vMAJOR.MINOR.PATCH tag (optional prerelease suffix).
3. Exact Git source commit SHA-1 of that tag (40 lower-case hex digits).

A tag or checksum copied from the same untrusted release folder is not an independent trust root. Git tag names can be changed if repository protections allow it.

## Non-elevated command

Requires a trusted installation of GitHub CLI gh, online GitHub artifact attestations, and Node.js with tsx in this repository.

~~~powershell
node --import tsx scripts/verify-pinned-release-provenance.ts 'C:\path\to\nexowire-1.0.5.tgz' 'a5c42cd8e25b698d4e6dead4bb25102217362ca639e91040d55dec389bafc314' 'v1.0.5' 'a75d0d6c040bae2cd7d259a49521f33d56656fa4'
~~~

The three pins above describe the official previously validated v1.0.5 release (October 2026). Independently approve pins before relying on them for a future version.

The helper locally hashes the archive, then invokes gh attestation verify without a shell, enforcing:

- Exact repository Naveax/Nexowire
- Exact signer workflow Naveax/Nexowire/.github/workflows/release-readiness.yml
- Exact signer digest (source commit)
- Exact release tag source ref and exact source commit digest
- OIDC issuer https://token.actions.githubusercontent.com
- Refusal of self-hosted runners
- SLSA provenance v1 predicate

On successful GitHub CLI cryptographic verification, an independent JSON policy checks certificate identity, signed subject archive digest and name, in-toto statement type, timestamp, workflow parameters, builder identity and resolved source commit. Malformed and mismatching records are denied. The artifact is hashed again after verification.

The exported JSON policy evaluator **is not a cryptographic signature verifier**. Do not feed it arbitrary user-supplied JSON as authorization evidence. Only the function that calls the real trusted GitHub CLI establishes the attestation verification result.

## Safety boundaries

GitHub Actions provenance is not a separately issued Nexowire Authenticode publisher signature, and it cannot establish that the approved build workflow itself is uncompromised. This does not verify any package dependency outside the archived tree, Windows ACLs, local installer identity, Task Scheduler principal, OAuth and DPAPI secret recovery, updater compatibility or actual rollback.

A valid result deliberately returns protectedAclVerified=false, authorizedInstallerVerified=false, safeToElevate=false, productionModified=false.

Before any Highest/SYSTEM cutover: independently verify full release tree integrity, stage it in a genuinely administrator-protected directory, audit effective ACL and path replacement across every dependency and parent, preserve and actually test protected credential/task rollback, and require an owner-authorized maintenance window.

Naveax's existing legacy Stack remains in service and is **not repaired** by this read-only verifier. No live Windows task, process, port, ACL or credential is modified.
