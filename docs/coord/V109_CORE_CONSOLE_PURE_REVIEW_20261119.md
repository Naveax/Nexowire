# AI-08: one additional reviewed portable CORE test (2026-11-19)

Source parent: `151c6a89a493ca72906d39262456d72367cb6fa0` (Draft #1160 integration).

Reviewed test: `test/core-console-enrollment-policy.test.ts`, Git blob `416167d7389f722d378f6fcd2b9ed61da813713b`.
Direct local dependency: `src/agent/core-console-enrollment-policy.ts`, Git blob `8383e94acaa2c3accac6960bbf75c6daa1954c1f`.

The test uses Node's test/assert/crypto modules and one local, pure signature-verification policy module. It contains no device call, subprocess, filesystem write, network listener, or privileged Windows operation. Both files are pinned into the existing source/closure gates. The allowlist expands from 32 to 33 files; the static pure import graph expands from 25 tests/30 dependencies to 26 tests/31 dependencies. No other tracked tests are admitted. This does **not** change the unsafe legacy `npm test` glob, establish full test coverage, or prove physical CORE admission.

Required acceptance: hosted Node 22/24 Portable Root Test Smoke and Test Discovery Inventory on this branch's exact commit, followed by CI/Release and separate integration review. Do not promote on historical CI alone.
