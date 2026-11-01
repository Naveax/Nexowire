# T-241 — GitHub pagination / truncated snapshot audit

`github-pagination-audit.mjs` is a **read-only, offline** validator of captured
GitHub REST pages. It never fetches URLs, uses credentials or changes a PR.

```sh
node --test test/delegated/pool-k20/*.test.mjs
node scripts/delegated/pool-k20/github-pagination-audit.mjs --input captured-pages.json
```

Input: `{ "pages": [{ "page": 1, "perPage": 100, "httpStatus": 200,
"items": [{"number": 123}], "link": null }], "totalCount": 1 }`.
Use each actual page's unmodified `Link` response header; include all `next`
pages. When reading search API responses, pass `incompleteResults: true` if
GitHub supplied `incomplete_results: true`, and `totalCount` from the response.

Rejects missing pages, nonconsecutive next pointers, duplicate IDs,
unrecognized/foreign Link URLs, 403/rate limits, truncated flags, and totals
larger than the captured unique item count. A full final page with no next Link
is deliberately `UNKNOWN`: do not silently call 100 returned entries exhaustive.
Even complete-looking local pages are labeled
`SNAPSHOT_CONSISTENT_NOT_LIVE_VERIFIED`, never live GitHub acceptance.

Test: five local synthetic cases/groups with positives and negatives. Actual
network/API authenticity, current timestamp, permissions and CI: **NOT_RUN**.
