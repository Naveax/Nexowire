# Issue #539/#485: bounded admin denial and retry evidence

This offline deterministic DOM/VM probe exercises **only the presentation** in
`web/admin.js`, without real network, credentials or privilege changes.

- T-556: HTTP 403 response contains a **fake** token/stack marker in its body
  and status text. Any UI echo or parsing of the denied body is RED. It asserts
  a denial cannot create a successful status. No real secret is used.
- T-557: one live DOM sees **403 → pending retry → 403 → authenticated-looking
  200 fixture**. Pending/denied stages must hide prior success, show busy until
  settled, and never imply successful authorization. Only an actual 200 fixture
  may populate KPI counters, hide the prior alert and restore green status.

```sh
node --test test/delegated/k04/admin-auth-boundary.test.mjs
node test/delegated/k04/admin-auth-boundary.mjs /absolute/pinned/checkout/web/admin.js
```

Exit 0 from the second command is a **source/VM-only** pass. Exit 1 is an
actionable RED; exit 2 means probe error or NOT_RUN. An independent #539/R11
test in PR #1133 still observes the owner #1068 source calling both 401/403
`Offline`: passing these narrow privacy/retry probes **does not close that bug**.

Main/owner exact commit SHA, web/admin.js blob, CLI results and CI run IDs are
tracked in `ekip/durum/K04.md`. Nested tests need an exact-name hosted CI step;
generic green jobs are not proof of execution. Real browser, NVDA, Windows,
live admin, OAuth and physical acceptance are NOT_RUN. The UI owner #1068 is
responsible for any eventual source changes.
