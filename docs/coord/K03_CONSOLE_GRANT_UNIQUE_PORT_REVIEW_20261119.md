# K03 unique console-grant regression review (2026-11-19)

Original unmerged source: PR #1103, file `test/delegated/k03/console-grant-view.test.mjs`, Git blob `29364dbc36744a7e909c9954d96617c2a912be81`. The original PR still contains another separate test and is **not** wholesale merged by this port.

The selected file reads `web/app.js` and `web/index.html` and uses an isolated in-memory Node VM; it does not contact the Hub, Agent, Broker, Windows controls, or production network. Its four cases check: inactive console grant vs unproven input; active grant vs unverified Windows/UAC; offline snapshot vs broker-ready optimism; and distinct user-facing ROOT/CORE/Broker/UAC explanations. Existing #1160 K03 offline tests cover dashboard state/bridge command behavior, but this particular grant-presentation fixture was absent at this path.

Hosted general CI now executes the one exact file as an explicit path in its Linux Node 22/24 matrix, with TAP zero-fail/zero-skip/zero-TODO and minimum 4 tests. A green hosted run is only **source/UI fixture acceptance**, never physical Windows input or UAC acceptance. Preserve #1103 for its other unique candidate, and avoid closing or bulk-merging it from this isolated port alone.

## Provenance refresh for explicit CI K03 step

The exact new Git blob of `.github/workflows/ci.yml` is `aba3bf105789e1b9e0c6e666849de8f6740ecda3` (previous candidate blob `f4ea3a9b4882fad640f04df7f7265dfe850938e6`). Three existing CSV manifests pin the integrated **candidate** blob and must match the new commit, while preserving their original source SHA/blob fields, row counts, and `EVOLVED` semantic-review classification. Only seven candidate-blob occurrences for this one CI path were refreshed: 2 in the Connection v2 matrix, 3 in AI05 Round2, and 2 in AI05 CORE/Connection. Provenance remains subject to hosted exact-head CI and does not imply a release gate was satisfied.
