# Issue #539 / T-413–T-414: sequential admin denial proof

The offline VM reuses **one DOM and one page script** across two requests:

1. Successful HTTP 200 overview, with a visible green policy pill and user counter.
2. A later HTTP 401, 403 or 503, with the exact previous DOM kept alive.

The resulting checks distinguish a denied request from a network outage, prove
whether previous counters were cleared, ensure the error remains visible, and
verify two credentialed, read-only `GET /api/v1/admin/overview` calls. The
401/403 error text must remain distinguishable to the user. This harness makes
no request to a real Nexowire server; it neither changes authentication nor
reproduces a live account failure.

Run harness unit/negative tests:

```sh
node --test test/delegated/k04/admin-denial-sequence.test.mjs
```

Run the actual source acceptance probe against a **pinned checkout** of either
upstream main or the owner coordination PR #1068:

```sh
node test/delegated/k04/admin-denial-sequence.mjs /absolute/path/to/checkout/web/admin.js
```

Exit 0 means this narrow three-case source-level audit passed. Exit 1 means
at least one case is **RED**; exit 2 means `NOT_RUN` or a probe error. Even an
exit 0 is not browser, NVDA, Windows, API, or live-admin acceptance. The code
under `web/admin.*` belongs to owner PR #1068 until the coordinator merges it;
do not patch that source in this PR. Main integration and exact-head CI are
separate gates. No workflow-dispatch action is performed here.
