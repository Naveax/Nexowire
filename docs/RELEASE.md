# Release Readiness

Nexowire is packaged as a self-hosted first-party runtime. GitHub release artifacts are the initial distribution path; npm publishing remains disabled by `"private": true` until an explicit publishing decision is made.

## Published stable release

Nexowire v1.0.2 was published on 2026-10-07 from tag `v1.0.2` at commit `68230bc52d3365aa983110512a860ea1a31234f8`. Authorized publisher run `37617454518` passed the final release gate and created the exact tag; tag-scoped Release Readiness run `37617530936` then passed Linux/macOS/Windows packaging, Windows singleton/setup smoke, checksum/manifest/SBOM verification, SLSA and SBOM attestations, and GitHub Release publication. The release contains the canonical tarball, SHA256 sums, release manifest, CycloneDX SBOM, `Nexowire-Setup.cmd`, `Nexowire-Windows-x64.zip`, and Windows SHA256 sums. npm publication remains disabled.

Live v1.0.2 acceptance after publication:

- `Naveax` was migrated from the v1.0.1 versioned runtime to the checksum-verified v1.0.2 Windows payload at `1.0.2-68230bc52d33`; the old v1.0.1 install remains as rollback. The stale old agent was removed with exact PID/command guards and the canonical Scheduled Task reconnected on the same stable device ID reporting v1.0.2.
- `work-pc` Hub and Agent report v1.0.2 and bounded Hub/Agent restart recovery passed on the same stable device ID. Its self-host wiring still uses the npm-global runtime path.
- Naveax Privileged Broker remains live on loopback `127.0.0.1:43112`. work-pc still requires one initial local administrator approval before its Privileged Broker can be installed.

## Unpublished v1.0.3 reboot-resilience candidate (2026-10-07)

A real `work-pc` Windows reboot exposed a lifecycle gap in v1.0.2: the public Hub Scheduled Task is `AtLogOn` with an Interactive principal, so after a cold reboot Nexowire can remain unavailable until that Windows user logs in. Calling this merely "autostart" hides an important boundary.

v1.0.3 is the candidate to close that gap:

- Add purpose-bound Windows DPAPI `LocalMachine` envelopes while retaining the existing current-user envelope format and default.
- Add an elevated `nexowire hub boot-install` path that re-seals the existing control-plane service token from current-user DPAPI to LocalMachine DPAPI without persisting plaintext.
- Store the machine envelope and boot launcher under `%ProgramData%\\Nexowire\\hub-boot` and harden that tree to SYSTEM and the built-in Administrators group.
- Register `Nexowire Hub Boot` as a SYSTEM `AtStartup` Scheduled Task so the public Hub can recover before an interactive user logon.
- Disable the legacy user-logon Hub only after the boot task is registered; if the SYSTEM Hub fails health validation, remove the boot task and restore/restart the previous user Hub.
- `boot-uninstall` reverses the change and restores the user Hub task.
- Native Agent remains a per-user/logon component; the pre-logon Hub exists so remote agents and the public MCP entry point do not depend on an interactive login.

The boot lifecycle intentionally requires one elevated installation because LocalMachine secret ACL hardening and a SYSTEM startup task are machine-level changes. It does not attempt to bypass UAC. Do not authorize or publish v1.0.3 until Windows CI proves LocalMachine DPAPI round-trip, cross-platform CI passes, and Release Readiness builds the checksum-pinned Windows candidate.

## Local release candidate check

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
- the Windows user bundle is built with a checksum-verified official Node runtime, and Release Readiness executes the generated `Nexowire-Setup.cmd` end-to-end in an isolated LocalAppData root before upload

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

The current stable v1 release line is versioned as `1.0.2`. GitHub Release is the distribution path; npm publication remains intentionally disabled by `"private": true`.

## Explicit GitHub Release authorization

Official GitHub publication is a separate, auditable mutation. The repository contains a publication workflow that runs only when an exact version authorization marker is merged to `main`. The workflow validates that the marker matches `v<package-version>`, creates or verifies the matching tag, and explicitly dispatches the tag-scoped release-readiness workflow. This explicit dispatch is required because a tag pushed with the workflow `GITHUB_TOKEN` does not recursively start another workflow. Before dispatching, the publisher checks for an already-active or successful Release Readiness run for the same tag and exact SHA, preventing duplicate release runs. The tag-scoped workflow reruns package verification, produces the canonical tarball/checksum/manifest/SBOM set plus Windows user assets, creates provenance/SBOM attestations, and publishes the GitHub Release only after all required jobs succeed.

The v1 release line keeps npm publishing disabled. Enabling npm requires a separate package-policy change because the release verifier intentionally requires `"private": true`.

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
