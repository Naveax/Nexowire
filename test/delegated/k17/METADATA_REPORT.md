# Shipped skill metadata audit — K17

Source snapshot: `Naveax/Nexowire` `main` at `93b6df33ef58610dcfdf3584bfe774e5afa7df4d` (2026-11-01).

## Scope and findings

- 45 shipped `skills/*/SKILL.md` files examined offline.
- Directory name, manifest `name`, and the normalized H1 title were consistent for all 45.
- Each shipped skill had an explicit name, description and version, with a description of at least 20 characters.
- No affirmative instruction matching the narrow permission-bypass patterns was detected. This is a heuristic text check, **not** a security certification.
- No inline Markdown links were present in the shipped `SKILL.md` collection. Link validation has positive and negative fixture coverage, but that empty catalogue result alone is not evidence of correct URLs.
- The manifest schema has `description`, but no structured `examples` field. No separate `## Examples` sections were present in this snapshot; therefore **example quality is UNKNOWN / not evaluated**. Adding examples or expanding the manifest schema is a separate product decision.

## Reproduction

```sh
node --import tsx test/delegated/k17/skill-metadata-audit.test.ts
npm run typecheck
```

The existing `npm test` glob does not discover tests nested two levels below `test/` in a typical Bash shell. This suite must be explicitly invoked until the CI/test owner wires delegated paths into a runner. There is no live Agent, Hub, account, external URL fetch, or platform acceptance in these tests.

## Negative cases covered

1. Incorrect manifest directory and title, missing H1.
2. Missing/short description, duplicate `name`, path-unsafe skill name.
3. Affirmative auth/permission bypass instructions, contrasted with explicit safety warnings.
4. Missing local link target, missing heading anchor, unsupported URL scheme, repository escape.

## Bounded follow-up

- Consider a documented examples convention before enforcing any example presence or quality threshold.
- Ask the CI owner (K13) to invoke this delegated suite and other nested suites, preserving separate static/synthetic versus browser/device acceptance labels.

## P002 follow-up: T-215–T-220

- An additional offline suite checks blank identity metadata, duplicate frontmatter keys, malformed registry names, symlink-aware documentation links, case-insensitive name collisions, and capability/privilege interpretation without execution.
- The audit now marks missing or explicitly blank platform support metadata as `UNKNOWN`. Explicitly blank capability, mutation, privilege, trust and platform fields are flagged rather than silently described as safe. Runtime parser defaults are **not** altered by this audit.
- `SkillRegistry.validate()` now checks case-insensitive catalogue name collisions in stable codepoint order. Ordinary discovery keeps the existing behaviour of listing both names; validation is the explicit gate.
- **Known open gap:** `SkillRegistry.load(name)` follows a symlink whose name is syntactically valid but whose resolved directory is outside the configured skills root. The runnable negative is marked `TODO` until the owner of protected runtime/path trust policy authorizes a fix. Ordinary `list()`/`validate()` ignore symlink entries; that does not make direct `load()` safe.
- `docs/SKILLS.md` already has a checked static shipped-skill index matching the 45 validated catalogue entries. A second generated README would duplicate the source of truth, so T-220 needs no new generator.

Run: `node --import tsx test/delegated/k17/skill-metadata-followup.test.ts`. The TODO is an intentional **unresolved** negative, not a passing security result. Real Windows symlink acceptance is NOT_RUN.
