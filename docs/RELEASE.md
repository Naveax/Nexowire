# Release Readiness

Nexowire is packaged as a self-hosted first-party runtime. GitHub release artifacts are the initial distribution path; npm publishing remains disabled by `"private": true` until an explicit publishing decision is made.

## Published stable release\n\nNexowire v1.0.0 was published on 2026-10-01 from tag `v1.0.0` at commit `98d040c284efad7f726c3d3ccaa1771d385ed60d`. Tag-scoped Release Readiness run `36890669730` passed all package, verification, attestation, and GitHub Release publication jobs. The original v1.0.0 GitHub Release contains the canonical `.tgz`, `SHA256SUMS`, `release-manifest.json`, and CycloneDX SBOM. Windows one-click assets are added by the next version-tagged release; the existing v1.0.0 release remains immutable. npm publication remains disabled.\n\n## Local release candidate check

Run:

```bash
npm ci
npm run release:check
npm pack
node --import tsx scripts/generate-release-metadata.ts nexowire-<version>.tgz
npm sbom --sbom-format cyclonedx > nexowire-sbom.cdx.json
npm run release:verify -- nexowire-<version>.tgz
```

`release:check` proves the following before an artifact is accepted:

- the normal typecheck, continuation contract, and test suite pass
- TypeScript build succeeds
- the built CLI keeps its executable shebang
- CLI help reports the same version as `package.json`
- the npm tarball contains the runtime, bundled skills, README, and package metadata
- the Windows user bundle is built on a Windows runner from a checksum-verified official Node runtime and passes a bundled-runtime smoke test
- source, tests, GitHub workflow files, handoff state, and environment templates are not accidentally shipped
- every shipped skill contains its `SKILL.md`
- package file count and unpacked size remain bounded

## Windows one-click user distribution

The version-tagged GitHub Release also carries a Windows end-user path that does not require a preinstalled Node.js/npm toolchain:

- `Nexowire-Setup.cmd` is the file a normal Windows user opens.
- `Nexowire-Windows-x64.zip` is the versioned payload containing the built Nexowire runtime, production-only npm dependencies, bundled skills, an official Windows x64 Node runtime, and the Node distribution license.
- `SHA256SUMS-Windows` binds both Windows release assets.
- the setup script embeds the exact payload SHA-256, downloads only the matching `v<package-version>` GitHub Release asset, verifies it before extraction, and installs under `%LOCALAPPDATA%\\Nexowire\\versions\\<version>-<source-sha>`.
- installation requires no administrator elevation. A Start Menu `Nexowire` shortcut launches the connect process hidden through the bundled runtime.
- the native-agent lifecycle therefore records stable versioned runtime paths instead of a temporary Downloads/extraction path.

The Windows ZIP/setup assets receive their own release provenance attestations on tagged publication. The existing npm tarball remains the canonical developer/self-host artifact and its verification contract is unchanged.

## Runtime skill lookup

Packaged/global executions must not depend on the caller's current working directory. Nexowire resolves the bundled `skills/` directory from the installed module when no local working-directory skills folder exists. `NEXOWIRE_SKILLS_DIR` can override this explicitly.

## CI artifact

`.github/workflows/release-readiness.yml` runs on packaging-related pull requests, manually, and on `v*` tags. The clean tarball install/readiness check runs on Linux, Windows, and macOS; Linux produces the canonical `.tgz` Actions artifact. The workflow does not publish to npm or automatically create a public GitHub Release.

## Version discipline

The CLI version and `package.json` version must match. A version bump that updates only one side fails `release:check`.

On GitHub tag-triggered release-readiness runs, `release:tag:check` also requires the exact tag `v<package-version>`. For example, package version `0.1.0-dev.1` accepts only `v0.1.0-dev.1`; a stale or hand-typed mismatched tag fails before the canonical tarball is built. Pull-request and branch runs are intentionally non-tag no-ops for this check.

The v1 release line is now versioned as `1.0.0`. GitHub Release is the initial distribution path; npm publication remains intentionally disabled by `"private": true`.

## Explicit GitHub Release authorization

Official GitHub publication is a separate, auditable mutation. The repository contains a publication workflow that runs only when an exact version authorization marker is merged to `main`. The workflow validates that the marker matches `v<package-version>`, creates the matching tag, and dispatches the tag-scoped release-readiness workflow. The tag-scoped workflow reruns package verification, produces the canonical tarball/checksum/manifest/SBOM set, creates provenance/SBOM attestations, and publishes the GitHub Release only after all required jobs succeed.

The initial v1.0.0 release keeps npm publishing disabled. Enabling npm requires a separate package-policy change because the release verifier intentionally requires `"private": true`.

## Release provenance metadata

The canonical Linux release-candidate artifact also contains:

- `SHA256SUMS` binding the exact `.tgz` bytes to a SHA-256 digest
- `release-manifest.json` with package/version, source commit, artifact size/hash, Node engine, and the exact bundled skill inventory
- `nexowire-sbom.cdx.json` generated by npm in CycloneDX format

These files are evidence attached to a candidate artifact. They do not publish a package, create a tag, or create a GitHub Release. Publication remains a separate explicit mutation.


## Independent candidate verification

Generation and verification are intentionally separate steps. `verify-release-candidate.ts` re-reads the candidate tarball and rejects upload when any of the following drift:

- `SHA256SUMS` does not bind the exact tarball bytes
- manifest package/version/Node engine differs from `package.json`
- manifest source commit differs from the checkout
- manifest artifact filename/size/hash differs from the tarball
- manifest skill inventory differs from the checked-out bundled skills
- CycloneDX SBOM root component name/version differs from `package.json`
- `package.json` is no longer `"private": true`

The verifier does not create tags, releases, or publications. It exists specifically so the workflow does not trust its own generation step merely because generation exited successfully.


## Tag-only signed attestations

Pull requests and manual branch readiness runs stop at verified candidate artifacts. They do not receive OIDC or attestation write permissions.

Only a matching `v<package-version>` tag ref unlocks the separate attestation job, either from an explicit tag push or an explicit workflow dispatch scoped to that tag. The authorized publication workflow uses the latter after creating or verifying the exact tag. The attestation job waits for every package-matrix leg, downloads the already verified canonical candidate, re-checks `SHA256SUMS`, then creates:

- SLSA build provenance for the exact `.tgz`
- a CycloneDX SBOM attestation for the same `.tgz`

The attestation job alone receives `id-token: write`, `attestations: write`, and `artifact-metadata: write`. The package/test jobs keep read-only repository permissions.

Because Nexowire is a public repository, GitHub artifact attestations use the public Sigstore infrastructure and are associated with the repository. Creating the exact tag is therefore the explicit release mutation that permits this public provenance step. The tag-scoped workflow may create the GitHub Release only after package and attestation jobs succeed; npm publication remains disabled.
