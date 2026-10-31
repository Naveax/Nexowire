# AI-07 test evidence (2026-10-31)
- Linux isolated workspace, Node 22.16.0: `node --experimental-strip-types --test test/ai07-sandbox-windows-probe.test.ts`: **exit 0**, **2/2 PASS**, **static source only**.
- New mutation-state regression: written but **NOT RUN LOCALLY** against full repository (tsx and whole repo unavailable in workspace).
- Native Windows MSVC build and AppContainer/Job readback: **NOT RUN**; disposable Windows VM unavailable. No physical PASS claimed.
- Linux namespace selftest in disposable lab: **NOT RUN**. No physical PASS claimed.
- Whole-repo `npm run typecheck`, existing tests, new exact-head CI: verify via remote Actions; prior #859 CI run `40547392793` is **not** a new-head result.
- No real installed/signed Agent, two-device owner grant/CAS, physical file/network/handle/descendant/revoke evidence: **NO-GO**.

- AI-07 hostile-input source negatives: added; exact-head CI pending, no physical validation claimed.

- Revoked Proxy negative test added: `Array.isArray` can throw `TypeError` for revoked Proxies; parser now handles it and returns deny-only decisions. Exact-head CI still required.

## Native probe hardening, current change (2026-10-31)
- Linux native source: `test/task-os-sandbox-linux-native-p07.test.ts` verifies compile, deny-only CLI, and static FD 0..MAX / strict seccomp; opt-in namespace selftest remains separate from source tests. Actual physical namespace selftest **NOT RUN** in real installed Agent.
- Windows source: `test/ai07-sandbox-windows-probe.test.ts` checks MSVC Advapi32 linker directive and primary token / KILL_ON_JOB_CLOSE readbacks; Windows MSVC compile/runtime **NOT RUN locally**. Dedicated Windows runner with Visual Studio dev environment still required.
- New HEAD CI result and exact exit statuses must be taken from GitHub Actions for that SHA; earlier CI `41195960785` 7/7 SUCCESS was only for `10463c1a9bacad950b053c9106ee580ff6fed1ad`.
