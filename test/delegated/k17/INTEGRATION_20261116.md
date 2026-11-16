# K17 skill direct-load containment integration — 2026-11-16

## Evidence and source

- Existing integration base: `ffab2b50eaa765b85c24c414c438fb6950d31aaf` (Draft #1160 line).
- Imported source-only skill evidence from Draft PR #1150 exact head `94c70d5e28b37cc53658e06942aa379d74ffbe2f`.
- Reproduced the previously documented path escape on the real Work-PC using **synthetic files only**: `SkillRegistry.list()` returned zero entries while `SkillRegistry.load('linked-skill')` followed a Windows junction outside the catalog.
- Changed `src/skills/registry.ts` to reject symlinked/junction skill directories and symlinked `SKILL.md` files during every direct load/read, validating the canonical directory and manifest remain inside the configured root.
- Converted K17's historical gap-reproduction assertions into fail-closed regression assertions; added a cross-platform symlink/junction regression for direct load and replacement after `validate()`. Existing manifest parser and exact-case behaviors remain tested.

## Verification and limitations

- Windows K17 suite: 10 total, 8 PASS, 0 FAIL, 2 SKIP. The two skipped scenarios create **file** symlinks without Windows symlink privilege; directory symlink scenarios are executed with Windows junctions, not skipped. Installed application and real credentials are not touched.
- The K17 suite is now explicitly selected in the delegated CI source-transfer lane; the total expected Linux assertions change from 362 to 372. Linux-hosted execution, zero skips, and CI outcome remain subject to exact-HEAD workflow result inspection.
- Source blob pointers in the 79/243/290-entry provenance CSVs were refreshed after CI changes. Source and candidate identities must not be conflated.
- This mitigates **observed sequential link and directory-swap reads**. It is not proof against adversarial concurrent filesystem races between path checks and file read, hardlinks, catalog ACL attacks, or arbitrary code loaded through other paths. No such stronger guarantee is claimed.
- No Windows SYSTEM Hub migration, CORE elevation, runtime deployment, or external device acceptance was performed.

The imported `P006_SKILL_SOURCE_EVIDENCE.md` is a **dated historical snapshot** describing the pre-fix behavior. This report records the subsequent candidate-source mitigation; issue #780 should not be declared closed without independently reviewed acceptance.
