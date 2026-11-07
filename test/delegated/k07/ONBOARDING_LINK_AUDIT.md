# Onboarding source QA — #485 / T-383 and T-389

Source baseline: upstream `Naveax/Nexowire` main `4e7db16f4233048a956664bef6b607781eb63fb7` (2026-11-07). This is a **source-link audit**, not live Windows installation acceptance.

## Verified release observation (2026-11-07)

- GitHub Releases API `releases/tags/v1.0.8` reports published, non-draft, non-prerelease release `v1.0.8`, `Nexowire-Setup.cmd` asset (6424 bytes) and SHA-256 digest `8f39a1954eb22131ed516d32acfad1fe17e3ccb9766eda3883b90595a9135694`.
- GitHub Releases API `releases/latest` returned tag `v1.0.8` **at observation time**; this is not a promise that the latest tag never changes.
- The normal Windows onboarding page `docs/INSTALL_WINDOWS.md` advertises exactly that versioned official download URL and digest. Archive `v1.0.7` is deliberately marked historical, not a fresh installer link.
- `docs/SELF_HOST.md` and `docs/DEPLOYMENT_ONBOARDING.md` are checked for actual relative files and GitHub-style heading anchors (including the link into the Turkish Windows guide).

## Repeatable offline test

`node --test test/delegated/k07/onboarding-link-integrity.test.mjs`

The test has independent negative fixtures for missing documents, renamed anchor, wrong release path, changed version label and mismatched checksum. The fixed release API result is a **dated observation fixture**, not a live HTTP probe or authenticity signature. Upon a new official release, re-check its tag, asset and checksum against the official GitHub API and refresh the fixture and guide together. Do **not** automatically replace the pinned URL with `releases/latest` as a direct installer.

## Evidence boundary

Links to the hosted control panel, ChatGPT product pages, and external docs were **not actively probed**; availability, OAuth readiness and the downloaded file's on-device hash remain **UNKNOWN/NOT_RUN** here. No live Hub/Agent, pairing, install, secrets or remote MCP calls were attempted. An installer hash or a matching release asset is not proof of a signed Nexowire publisher or physical CORE acceptance.

## Pairing recovery guide (T-389)

`node --test test/delegated/k07/pairing-recovery-guide.test.mjs`

The separate fixture checks current `docs/INSTALL_WINDOWS.md` guidance for an initial failed **BAĞLA** attempt (wait while **BAĞLANIYOR**, retry **TEKRAR DENE** once, then open a fresh pairing session), an exhausted device limit and the wrong GitHub account. It verifies guidance against deleting records/reinstalling or sharing OAuth secrets. It separately checks self-host diagnostic-first commands, and rejects unsafe sample advice (forced state reset, revealing credentials, or treating loopback as a remote ChatGPT URL). It does **not** execute pairing, alter account state, or validate OAuth behavior on a live device.
