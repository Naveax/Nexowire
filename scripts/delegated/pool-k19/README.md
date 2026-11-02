# Physical-device PASS label review (T-245)

This is a **read-only, advisory** source audit. It marks text which places `PASS`/`PASSED`/`✅` beside explicit real/physical/live device, PC, Windows or hardware language. A match means **human evidence review required**; it does not imply the author lied or that the test was fabricated. A clean scan does **not** establish physical acceptance.

```bash
node --import tsx scripts/delegated/pool-k19/audit-physical-pass-labels.ts docs
node --import tsx test/delegated/pool-k19/audit-physical-pass-labels.test.ts
```

Optional `--strict` exits with status 1 if review candidates exist. Default exits 0 after scanning even when candidates exist, so a legitimate historical hardware-test claim does not automatically break CI. Read errors return status 2. Target paths are explicit; an absent target or an oversized (over 2 MiB) text file aborts rather than looking "clean". Filesystem symlinks, non-Markdown/non-text files and code fences are ignored.

The scanner splits obvious semicolon/long-dash clauses so `synthetic CI PASS; physical two-PC NOT_RUN` is not falsely marked as physical success. It cannot establish source provenance, detect fabricated CI hyperlinks, validate physical hardware or correctly understand every natural-language nuance. Review original evidence and the exact CI job/device receipts manually before changing a project's status.

Fixture checks include positive review candidates, explicit `NOT_RUN`/negated PASS, unqualified Linux CI success, fence exclusion, deterministic path order and symlink omission. No external network, GitHub mutation, real device or secret is required.
