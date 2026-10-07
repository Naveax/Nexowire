# Release Readiness

Nexowire is packaged as a self-hosted first-party runtime. GitHub release artifacts are the initial distribution path; npm publishing remains disabled by `"private": true` until an explicit publishing decision is made.

## Published stable release

Nexowire v1.0.1 was published on 2026-10-05 from tag `v1.0.1` at commit `43779b1de5543146a283ae80771e65c51020bef2`. Authorized publisher run `37324592840` created the exact tag after its final release gate. Because GitHub suppresses recursive workflow triggers from `GITHUB_TOKEN` tag pushes, the tag-scoped Release Readiness run was explicitly dispatched once as run `37324999923`; it passed Linux/macOS/Windows packaging, the real Windows `cmd.exe` setup smoke, provenance/SBOM attestations, and GitHub Release publication. The public release contains the canonical `.tgz`, `SHA256SUMS`, `release-manifest.json`, CycloneDX SBOM, `Nexowire-Setup.cmd`, `Nexowire-Windows-x64.zip`, and `SHA256SUMS-Windows`. Independent post-publication download/hash/manifest/setup-pin checks and `gh attestation verify` passed for the canonical tarball, Windows payload, and setup script. The original v1.0.0 release remains immutable; npm publication remains disabled.

## Unpublished v1.0.2 release candidate (2026-10-07)

The next candidate is `v1.0.2` and is **not yet formally published or installed as a versioned v1.0.2 Windows bundle** on either live PC. The current production/control-plane and live-runtime acceptance work on main includes:

- The bounded, ANSI-clean Windows PowerShell `ACCESS_DENIED` diagnostic fix (PR #216).
- A user/device-scoped OS-owned Windows native-agent singleton lease to reject duplicate `agent run` launchers (PR #217), reproduced by named-pipe exclusivity smoke on Windows 10 and 11.
- Persistent per-device `SAFE` / `FULL ACCESS` control-plane state with fail-closed SAFE default, authenticated dashboard mutation, D1 migration `0009_device_access_mode.sql`, access-mode propagation to MCP/Hub/agent requests, and replay fingerprints that include the access mode (PR #222).
- Production Full Access deployment and dashboard assets with paid billing still disabled; the temporary auto-deploy gate was removed and deployment returned to manual-only.
- Naveax Privileged Broker loopback routing validated with real machine-scope environment set/delete. The broker removes repeated per-operation UAC for supported elevated operations after its one-time elevated installation.
- Naveax Stack/Native-Agent overlap corrected so the Stack supervises the canonical Scheduled Task instead of launching a duplicate agent.
- A mandatory **real Windows CI and Windows Release Readiness** singleton test, not just Linux-simulated tests.
- Versioned Windows x64 payload and installer candidate smoke; v1.0.1 remains the published stable release until a separately authorized v1.0.2 tag/publication.

Live-PC state before publication:

- `Naveax`: v1.0.1 versioned install with validated v1.0.2 compiled-runtime overlay for acceptance, rollback copies retained; Privileged Broker is live on loopback `127.0.0.1:43112`.
- `work-pc`: v1.0.1 Hub/Agent is online; Privileged Broker is not yet installed. The official installer correctly refuses from its non-elevated agent and requires one initial local administrator approval.
- Neither PC should be called a clean v1.0.2 install until the signed/checksum-pinned v1.0.2 Windows release bundle is produced and installed through the normal versioned installer.

Do **not** create/publish the v1.0.2 tag until the branch Release Readiness artifacts pass on Linux/Windows/macOS and the Windows setup/payload/checksum candidate is inspected. Do not enable payments. After readiness passes, use a staggered one-device-at-a-time update with rollback, starting with Naveax and leaving work-pc Hub/Tailscale available as the second control path.

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

The current stable v1 release line is versioned as `1.0.1`. GitHub Release is the distribution path; npm publication remains intentionally disabled by `"private": true`.

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
