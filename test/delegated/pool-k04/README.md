# T-238 — Delegated test extension discovery probe

Run the isolated fixture tests:


```sh
node test/delegated/pool-k04/probe-runner.test.mjs
```

Run against a specific checked-out K13 runner implementation (read-only):

```sh
node test/delegated/pool-k04/probe-runner.mjs /path/to/k13/scripts/delegated/k13/run-delegated-tests.mjs
```

This VM probe supplies synthetic nested test files and spies on `spawnSync`.
It ensures all `.test.mjs`, `.test.cjs`, `.test.js` and
`.test.ts` fixtures are selected once, and that a ts-only pattern, silent
no-spawn behavior or inadvertent unsupported extensions are reported.

The K13 runner source is not part of upstream `main` yet; this PR does not
copy or modify K13-owned files. The probe **does not execute** real tests, npm,
services, CI, Windows or a browser. Its outcome is source-discovery evidence
only; exact-HEAD CI still requires separate authorization.
