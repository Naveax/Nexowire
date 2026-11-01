# Offline touch-target evidence format (T-253)

Run from the repository root:

```sh
node test/delegated/pool-k05/touch-evidence.test.mjs
```

`touch-evidence.fixture.json` is **source-only, NOT_RUN**. It records one CSS candidate
but does not claim rendered target width, spacing, mobile screenshot or real
touchscreen usability. A valid `OBSERVED` record needs finite dimensions and an
artifact reference; even then the report says `observedUnverified`, not PASS.

No WCAG exception/spacing rule is decided by this validator. Real browser/touch
and accessibility review are independently required. K02 owns any `web/styles.css`
change; this task only adds an offline QA evidence structure.
