# AI-04 CONTRACT

## External Broker effect
- Every privileged *effect* calls `invokeBrokerEffectOnce` with stable UUID, exact frozen capability/input digest and bounded owner/device/session scope.
- `readVerifiedBinding` and `readVerifiedBindingNow` must return a standalone plain own-data record. Inherited properties, accessors and exceptions fail closed. The data is immediately snapshotted and frozen; no caller-owned mutable reference is consumed after validation.
- RESERVED and COMMITTED must carry independent fresh challenges, same ticket, immutable scope and exact signed payload bytes. `verifyReceipt(receipt,signedPayloadUtf8)` must independently authenticate those bytes with a pinned authority; a synthetic boolean is never production verification.
- Missing acknowledgement, expired monotonic budget, mismatched native evidence or revoke/UNKNOWN means no callback. The external authority must enforce durable one-use semantics, including process restarts.
- Local admission is not a replacement for AI-05 executor fencing or Broker-side wire admission.

## Windows Job
- Job membership alone is insufficient to prove isolation: escaped/duplicated handles, pre-seal windows, nested Jobs, descendants, breakaway and SeDebug/SYSTEM peers remain independent kernel boundaries.
- `NX_GUARDIAN_HIGH_DACL_PROVISIONAL` and synthetic receipts are not installed-Broker acceptance.
- Every unavailable or unsupported kernel result is UNKNOWN/BLOCKED, not PASS. MSVC C4133 is a failure, not a compiler warning to suppress.

## Native Job handle inheritance (AI-04)
- Guardian must create the root with `STARTUPINFOEXW`, `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, and exactly its duplicated standard IO handles. An implicit inherited ancestor token, Job, file or pipe must never be accepted as safe.
- Failure to duplicate standard IO or configure the attribute list fails closed before the root is created. This is a process-launch restriction, not a full AI-07 sandbox or installed-Broker physical trust proof.
