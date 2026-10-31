# Same-exact-SHA CORE early-completion adversarial source gate

**Source-only; CORE production NO-GO.** Base #985 exact head `d9dc636ebbabe7a82a5e34170da5e7517eeb22d4`; coordinator migration and tests from #996 exact head `71286f47b11c6ba76ea59309c5a1aba4c3ea82dd`; independently authored, **unchanged** AI-08 early-ACK negative from #989 exact head `bb14213b43b127724875eadd170b2d9f5f9b28d1`.

This child adds no runtime bypass, no synthetic owner approval, and does not modify any AI-owned source file. Exact upstream test blobs are preserved. It exists to force the AI-06 native claim code, independent D1 migration and unrelaxed AI-08 race tests to execute in the **same CI build**, rather than considering separate green PRs sufficient.

Required P0 acceptance: before current native readback resolves, a competing signed `complete(succeeded)` must be **rejected without success ACK**; native DENY/UNKNOWN leaves durable terminal no-replay tombstone; duplicate claims cannot tombstone the winner, and immutable device/owner/session/fingerprint/revoke fields survive adversarial changes. CI must run all native/session tests with same exact HEAD and no skipped Windows physical checks treated as PASS.

Synthetic D1 tests do not prove real protected OS owner consent or effect-boundary; require physical two-PC acceptance before CORE GO.
