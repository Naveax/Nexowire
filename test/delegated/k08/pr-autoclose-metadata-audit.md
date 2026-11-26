# D-123 — 59 open Draft PRs, auto-close metadata audit

Read-only snapshot: **2026-11-09 (Europe/Istanbul)**, P007/V006,
upstream `main@52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`.
Source of candidate PR numbers: `ekip/PR_DENETIM_20261108.md`'s 59-entry inventory;
then independently fetched each PR's **current GitHub title, description,
open state and exact head SHA** using the GitHub PR API, not the archived
PR-description excerpt. All **59/59 fetches succeeded**, all 59 were still
open at this observation; none is asserted merge-ready from this scan.

## What was checked and what was found

- Scan target: all **59 PR titles + full PR descriptions** (not comments,
  commit messages, diff text, release notes or hidden GitHub settings).
- Case-insensitive regex for a closing keyword next to an issue identifier:
  `\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s*#(\d+)\b`.
  **Do not exempt negated English sentences**: “does not close #487” and
  “cannot fix #539” still contain the potentially actionable keyword/id pair.
  The test is deliberately conservative; only actual text matches count.
- **Result: 0/59 titles/bodies contained this pattern** at the listed exact
  PR HEADs. This is a *negative metadata finding*, not a conclusion that every
  commit, PR review/comment or future merged text is free of auto-close syntax.
- The five previously remediated descriptions were specifically rechecked:
  [#1100](https://github.com/Naveax/Nexowire/pull/1100),
  [#1101](https://github.com/Naveax/Nexowire/pull/1101),
  [#1115](https://github.com/Naveax/Nexowire/pull/1115),
  [#1121](https://github.com/Naveax/Nexowire/pull/1121),
  [#1122](https://github.com/Naveax/Nexowire/pull/1122).
  **All five now have zero keyword/id pair matches** in current title/body.
  This independently reconfirms the narrower `PR_DENETIM_20261108.md`
  cleanup statement; no PR metadata was changed by K08.

## Exact-head audit ledger

| PR | Current exact HEAD | State | Closing-pattern matches in title/body |
| --- | --- | --- | --- |
| [#1010](https://github.com/Naveax/Nexowire/pull/1010) | `3f6a226e4244d3a599d9631adf69bb40bf1f4c92` | open | 0 |
| [#1011](https://github.com/Naveax/Nexowire/pull/1011) | `6e740dfe919e5f615655f68815b078447915ce6f` | open | 0 |
| [#1015](https://github.com/Naveax/Nexowire/pull/1015) | `2d448f69a996feeefcfa4b657af7f5249ba94681` | open | 0 |
| [#1016](https://github.com/Naveax/Nexowire/pull/1016) | `96fa340b477915dc95dd4d8275c981b0a3b37f89` | open | 0 |
| [#1030](https://github.com/Naveax/Nexowire/pull/1030) | `bc97cd84c7b224cdfe140a77a7f9200d6bcf50e4` | open | 0 |
| [#1035](https://github.com/Naveax/Nexowire/pull/1035) | `e0de00624b1de3c0564ebc37e2c50ae914259a4f` | open | 0 |
| [#1099](https://github.com/Naveax/Nexowire/pull/1099) | `2ae40bd36a3e97b8544102a96b4e63673f6a5fd0` | open | 0 |
| [#1100](https://github.com/Naveax/Nexowire/pull/1100) | `6d8a555c371c323bb73d858053cd2794dde54152` | open | 0 |
| [#1101](https://github.com/Naveax/Nexowire/pull/1101) | `3d4408e84b50e7787dec922a0332ddb35156e700` | open | 0 |
| [#1103](https://github.com/Naveax/Nexowire/pull/1103) | `4d581bef3ca0ca26f626d6ecd499832f0af10e2c` | open | 0 |
| [#1104](https://github.com/Naveax/Nexowire/pull/1104) | `247be5e246ae19b0237841950f8c680ce10bfcf0` | open | 0 |
| [#1105](https://github.com/Naveax/Nexowire/pull/1105) | `13f6fc0e8041516554cf202a0cf79f119f600c19` | open | 0 |
| [#1106](https://github.com/Naveax/Nexowire/pull/1106) | `f52d4a3cb89fe5207a50ac7b21249d5410d7807a` | open | 0 |
| [#1107](https://github.com/Naveax/Nexowire/pull/1107) | `fed3b1c67a413a175e67593f87203e8610840d79` | open | 0 |
| [#1108](https://github.com/Naveax/Nexowire/pull/1108) | `85cee5223a8b6f26b6f2ac04699df5b7f70933c2` | open | 0 |
| [#1109](https://github.com/Naveax/Nexowire/pull/1109) | `d14a24c52243371d1111634d26ea0e256164b7ac` | open | 0 |
| [#1110](https://github.com/Naveax/Nexowire/pull/1110) | `757f1aab471f0ff6034079b152ac17b22171c990` | open | 0 |
| [#1111](https://github.com/Naveax/Nexowire/pull/1111) | `c5119a65a914ec339ad1c362ba9ba1ca19e339b4` | open | 0 |
| [#1112](https://github.com/Naveax/Nexowire/pull/1112) | `3ca2cd12f003768ac66dea0f242b6b8007587101` | open | 0 |
| [#1113](https://github.com/Naveax/Nexowire/pull/1113) | `079cef00aaabc093fe400b47ef71e65144dff0f6` | open | 0 |
| [#1114](https://github.com/Naveax/Nexowire/pull/1114) | `edd73b575fdbe1eb38f8b47b43a098a1aa35e957` | open | 0 |
| [#1115](https://github.com/Naveax/Nexowire/pull/1115) | `2a74d9d2c0c42265c4ee27494eb530059904c0b3` | open | 0 |
| [#1116](https://github.com/Naveax/Nexowire/pull/1116) | `6642a138e6556209bf35122c1614b082113e743e` | open | 0 |
| [#1117](https://github.com/Naveax/Nexowire/pull/1117) | `822b4247dc7066897ac6427723e1c4c99083c1e4` | open | 0 |
| [#1118](https://github.com/Naveax/Nexowire/pull/1118) | `d51d9d4c2c25797405227bad223039c6b31055d2` | open | 0 |
| [#1119](https://github.com/Naveax/Nexowire/pull/1119) | `6515f3777e510a6f62c8bc6cf9333d2fbe67877e` | open | 0 |
| [#1120](https://github.com/Naveax/Nexowire/pull/1120) | `f6ae93d8746f5b753618cbbb5f1f1b2a73ef2090` | open | 0 |
| [#1121](https://github.com/Naveax/Nexowire/pull/1121) | `1b97d6341c036e1eadde491be1abfe743c716b7c` | open | 0 |
| [#1122](https://github.com/Naveax/Nexowire/pull/1122) | `aaa96bde77bd6c4a03bc6b653be268727ee44f18` | open | 0 |
| [#1123](https://github.com/Naveax/Nexowire/pull/1123) | `eed5becc5bb107a26e0c789f81ca9dd9c4230e0e` | open | 0 |
| [#1124](https://github.com/Naveax/Nexowire/pull/1124) | `4d1a3dc32bd8c6718392ec743769c5409e114f3c` | open | 0 |
| [#1125](https://github.com/Naveax/Nexowire/pull/1125) | `fdea20a8758dc734f65ad3fd2f9001dfe4438235` | open | 0 |
| [#1126](https://github.com/Naveax/Nexowire/pull/1126) | `332e211e8894bfa6222ecc9c0e03b89463b8acd0` | open | 0 |
| [#1127](https://github.com/Naveax/Nexowire/pull/1127) | `32f76f575c4baf68c4c3c105bbcc7726c3999610` | open | 0 |
| [#1128](https://github.com/Naveax/Nexowire/pull/1128) | `5f2b654d4c23d55a1ff3dd141f2117cb9e7f0872` | open | 0 |
| [#1129](https://github.com/Naveax/Nexowire/pull/1129) | `eb89ea72f73a7549cd44831537c1ccd5093efe3d` | open | 0 |
| [#1130](https://github.com/Naveax/Nexowire/pull/1130) | `8a5bc56ebe1004595e4cebbd5bc363fe51892534` | open | 0 |
| [#1131](https://github.com/Naveax/Nexowire/pull/1131) | `a670647298d878d71f60e3a4af1a660ac2a30c37` | open | 0 |
| [#1132](https://github.com/Naveax/Nexowire/pull/1132) | `1f1d912b164a01485abdf3b56cfe62fa37752955` | open | 0 |
| [#1133](https://github.com/Naveax/Nexowire/pull/1133) | `98beceafb1ef6715ae44dff56fdb70fb2ed0351d` | open | 0 |
| [#1134](https://github.com/Naveax/Nexowire/pull/1134) | `ec640fc144b1fe10e4a4490f353fd753eeaf3ad5` | open | 0 |
| [#1136](https://github.com/Naveax/Nexowire/pull/1136) | `ed5fa137bc875e613691e13d1b72a8df9ebf9d56` | open | 0 |
| [#1137](https://github.com/Naveax/Nexowire/pull/1137) | `4869fe31ff47c97220c73af66a4eab5d3c73f027` | open | 0 |
| [#1138](https://github.com/Naveax/Nexowire/pull/1138) | `db4ed19f7d19db0102942fbe25f75b2d1831b62e` | open | 0 |
| [#1139](https://github.com/Naveax/Nexowire/pull/1139) | `51d8400430dd0b78bee6afb300cfe44ac67e560d` | open | 0 |
| [#1140](https://github.com/Naveax/Nexowire/pull/1140) | `ec1f38d8db3a74eb8fe300218fc4190a2a591ac2` | open | 0 |
| [#1141](https://github.com/Naveax/Nexowire/pull/1141) | `a13dd68d0585d5f4b2617beb121702a2db7850ea` | open | 0 |
| [#1142](https://github.com/Naveax/Nexowire/pull/1142) | `fa7659a5f86fbacb6a12fbdfbf5efac27229a40e` | open | 0 |
| [#1143](https://github.com/Naveax/Nexowire/pull/1143) | `ba838a28562c9226c69d795bbd4b4e23190f8162` | open | 0 |
| [#1144](https://github.com/Naveax/Nexowire/pull/1144) | `bece6bfeaea4b501349aa03ff15c185666a99fd5` | open | 0 |
| [#1145](https://github.com/Naveax/Nexowire/pull/1145) | `3f270754f4126325667b2a6adbd4b7e091ceebd6` | open | 0 |
| [#1146](https://github.com/Naveax/Nexowire/pull/1146) | `54b387cb5a03c75f62ef9be337f09fb54ceb0b99` | open | 0 |
| [#1147](https://github.com/Naveax/Nexowire/pull/1147) | `f552c77983fa73feeb3220e961c23bd747b76641` | open | 0 |
| [#1148](https://github.com/Naveax/Nexowire/pull/1148) | `5b0f98c2f41ac332b02d8b8fc78beff9e5efda7d` | open | 0 |
| [#1149](https://github.com/Naveax/Nexowire/pull/1149) | `b6b5e60ba93f1a40fab432fedc06d334971a6c37` | open | 0 |
| [#1150](https://github.com/Naveax/Nexowire/pull/1150) | `f3413ec840a82cb13c68a364c1a1ed4f663343d2` | open | 0 |
| [#1151](https://github.com/Naveax/Nexowire/pull/1151) | `6ccf58e6f0e7ea2e84035c14bde1382ab8b2422e` | open | 0 |
| [#1152](https://github.com/Naveax/Nexowire/pull/1152) | `88b893e78320c3ca2a13d5266e5d9c41c178a43d` | open | 0 |
| [#1153](https://github.com/Naveax/Nexowire/pull/1153) | `eb3327e0adfd0910c57daab8e4cb6051c4ff6b1c` | open | 0 |

## Owner handoff and open limitations

- **K14 / [#1153](https://github.com/Naveax/Nexowire/pull/1153):** attach
  this audited 59/59 title/body result to the final PR integration checklist;
  compare new HEAD/description again immediately before a maintainer-approved
  merge. A later edit invalidates this snapshot's safety claim.
- **K20 / CI coordination:** no source test or required CI result can prove
  GitHub metadata will stay unchanged. Read-only QA here creates no status
  check and does not trigger or cancel an Actions run.
- **Remaining exposure:** commit messages (including squash-merge subject
  chosen in UI), owner PRs outside this 59-entry user-owned inventory,
  descriptions added later, and the final merge text were **NOT_CHECKED**.
  Do not infer absence of auto-close risk for those surfaces or that an issue
  was legitimately resolved. Only the repository owner can authorize merge;
  K08 made no issue-close, PR-close, PR-body edit or upstream merge.

This audit supports issue [#1006](https://github.com/Naveax/Nexowire/issues/1006)
release-handoff process and P007 D-123; it does **not** close or repair the
underlying product issues. Actual Hub/Agent/Windows/provider acceptance is
**NOT_RUN**, unrelated to this metadata-only inspection.
