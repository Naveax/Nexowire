# Release Readiness

Nexowire is packaged as a self-hosted first-party runtime. GitHub release artifacts are the initial distribution path; npm publishing remains disabled by `"private": true` until an explicit publishing decision is made.

## Published stable release

Nexowire v1.0.4 was published on 2026-10-07 from tag `v1.0.4` at exact commit `e5f865f4d252406a129a2a5d58a499f68fd09ae5`. Exact-main CI `37685751072`, authorized publisher `37685751071`, and tag-scoped Release Readiness `37685873099` all completed successfully. The annotated tag dereferences to that exact commit; the GitHub Release was published at `2026-10-07T21:01:56Z` with the canonical tarball, CycloneDX SBOM, release manifest, SHA256SUMS, Windows checksum file, Windows ZIP, and setup CMD. npm publication remains disabled.

Live Windows rollout state verified 2026-10-08:

- `Naveax` remains on checksum-verified versioned runtime `1.0.3-2b0b1f9193de`; its canonical Native Agent process was observed from that exact runtime and loopback broker TCP `127.0.0.1:43112` is reachable.
- `work-pc` runs v1.0.4 Hub and Native Agent processes from `1.0.4-e5f865f4d252`; its `BUILD.txt` source is exact main `e5f865f4d252406a129a2a5d58a499f68fd09ae5`.
- work-pc completed the elevated machine-level install using an already-authorized SYSTEM maintenance channel, without clicking or bypassing UAC. `Nexowire Hub Boot` is Running as SYSTEM/Highest/AtStartup in Session 0; its `1.0.4-e5f865f4d252` Hub listens on `127.0.0.1:43110`, and its protected token uses LocalMachine DPAPI. The older per-user Hub task is Disabled to prevent duplicate listeners.
- `Nexowire Privileged Broker` is Running at elevated logon on `127.0.0.1:43112`. The v1.0.4 Native Agent launcher uses broker mode and its first-party privileged `windows.task.control` was verified. A broken recursive ProgramData child ACL was diagnosed and corrected, all Hub Boot files now have explicit SYSTEM/Administrators-only ACLs, and ephemeral elevated installer tasks and executable scripts were removed. Actual cold reboot before user login and authenticated owner-dashboard entitlement are still outstanding.
- The newer main-only source fixes #237 (owner FULL ACCESS does not spawn a redundant Console Control modal) and #238 (protect ProgramData child ACLs and tolerate nullable TaskScheduler timestamps) passed CI. PR #239 additionally upgraded the MCP SDK from locked 1.30.1 to 1.32.1 to address high-severity OAuth credential-destination advisory GHSA-6qxp-vccf-f47h; clean npm audit reports 0 vulnerabilities, and CI/Release Readiness passed. None of these changes altered the immutable v1.0.4 release payload; ship them in a separate authorized release before claiming upgraded runtime behavior.

## v1.0.4 release details

PR #230 merged **after** the immutable v1.0.3 tag, so its native/runtime changes shipped as v1.0.4 rather than rewriting v1.0.3. Release-prep PR #234 passed its CI/Release Readiness gates, authorization PR #235 merged as exact main `e5f865f4d252406a129a2a5d58a499f68fd09ae5`, publisher run `37685751071` created the tag/dispatch, and tag-scoped Release Readiness run `37685873099` published the release successfully.

v1.0.4 adds:

- official `nexowire update status/check/apply` live-update capabilities;
- checksum-verified, side-by-side Windows release staging with atomic Agent/Hub cutover and rollback state;
- machine-level update scheduling through the already-elevated Privileged Broker for components that require administrator context;
- authenticated Privileged Broker `/health` with version/elevation status;
- ProgramData ACL hardening for the privileged broker;
- agent hello/runtime telemetry for `agentVersion`, `privilegeMode`, and `adminBridgeReady`;
- D1 migration `0010_device_runtime_telemetry.sql` and dashboard/control-plane fields for those runtime signals.

The control-plane half of this feature was deployed successfully from main commit `97bbbbbd45294f4a7349b878ada42d48f6582b3b` in production deploy run `37678901638`. The final v1.0.4 publication path is independently verified: exact-main CI `37685751072` succeeded, publisher `37685751071` succeeded, tag-scoped Release Readiness `37685873099` succeeded, annotated tag `v1.0.4` dereferences to exact commit `e5f865f4d252406a129a2a5d58a499f68fd09ae5`, and the public GitHub Release exposes seven expected canonical assets. work-pc is live on the matching v1.0.4 runtime; Naveax remains on v1.0.3. npm remains disabled and paid billing remains paused.

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

The current published-stable v1 release is `1.0.4` at exact commit `e5f865f4d252406a129a2a5d58a499f68fd09ae5`. GitHub Release is the distribution path; npm publication remains intentionally disabled by `"private": true`.

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
