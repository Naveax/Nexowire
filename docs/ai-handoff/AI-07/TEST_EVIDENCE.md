# AI-07 test evidence (2026-10-31)
- Linux isolated workspace, Node 22.16.0: `node --experimental-strip-types --test test/ai07-sandbox-windows-probe.test.ts`: **exit 0**, **2/2 PASS**, **static source only**.
- New mutation-state regression: written but **NOT RUN LOCALLY** against full repository (tsx and whole repo unavailable in workspace).
- Native Windows MSVC build and AppContainer/Job readback: **NOT RUN**; disposable Windows VM unavailable. No physical PASS claimed.
- Linux namespace selftest in disposable lab: **NOT RUN**. No physical PASS claimed.
- Whole-repo `npm run typecheck`, existing tests, new exact-head CI: verify via remote Actions; prior #859 CI run `40547392793` is **not** a new-head result.
- No real installed/signed Agent, two-device owner grant/CAS, physical file/network/handle/descendant/revoke evidence: **NO-GO**.

- AI-07 hostile-input source negatives: added; exact-head CI pending, no physical validation claimed.

- Revoked Proxy negative test added: `Array.isArray` can throw `TypeError` for revoked Proxies; parser now handles it and returns deny-only decisions. Exact-head CI still required.
