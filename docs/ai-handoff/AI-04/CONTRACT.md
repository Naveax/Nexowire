# AI-04 CONTRACT

## Broker-side effect admission
- Privileged mutation independently gated in Broker, not authorized by executor, HTTP bearer or caller-provided flags alone. Missing independent external authority => deny.
- `readVerifiedBinding()` and `readVerifiedBindingNow()` must supply owner/device/session/generation and protected broker/HIGH proof. Live provider-owned objects are copied from own data descriptors and frozen before validation. Accessors, inherited properties, throwing Proxy or UNKNOWN => deny.
- Scoped `operationId` (stable UUID), capability and SHA-256 of the **exact immutable callback input** form the per-effect request. Owner/device/session epochs and authority generation must remain equal from reserve through commit to the synchronous pre-effect readback.
- `begin(request,reserveNonce)` returns an externally authenticated RESERVED receipt. `commit(request,ticket,commitNonce)` returns COMMITTED receipt, reusing the **same ticket**, fresh challenge and immutable scope; lost ACK => terminal UNKNOWN. Revoke/readback/clock ambiguity => deny and no native callback.
- `verifyReceipt(receipt,signedPayloadUtf8)` must authenticate **that exact primitive UTF-8 byte string**, not transport-owned objects or reconstructed mutable data. Source-level mocks/boolean true do not substitute independent protected CAS/issuer evidence.

## Signed dispatch wire
- `BrokerExternalDispatchFence.decode` and `createBrokerDispatchAuthorityHandler.decode` first verify Ed25519 signature against original bytes with pinned issuer key.
- The signed JSON UTF-8 payload MUST be byte-identical to `Buffer.from(JSON.stringify(JSON.parse(bytes)), 'utf8')`; this is an explicit JavaScript `JSON.stringify` compact wire format, **not RFC 8785**.
- Duplicate keys, whitespace variation, alternate JSON Unicode escapes and invalid UTF-8 are rejected **even when a test key validly signed those bytes**. A non-JS authority needs explicit cross-language test vectors before integration.
- Adapter-side protected Broker readback is independently server-generated, not trusted from client HTTP JSON. A detached frozen JS witness is a TOCTOU guard, **not OS attestation**.

## Windows Job
- Windows helper must verify HIGH token/ACL, Job assignment, limits, non-breakaway and child identity with actual Win32 APIs before releasing a suspended root. Any unsupported/UNKNOWN result is BLOCKED.
- `native/windows-job-owner.c` uses `STARTUPINFOEXW` and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to duplicate/allow only stdin, stdout and stderr. Attribute construction failure aborts without unrestricted inheritance fallback.
- A Job handle, provisional DACL, synthetic process or MSVC compilation PASS is NOT proof against equal-HIGH SeDebug, a stolen handle before seal, or an owner-PC production threat model. C4133 warnings must remain fatal.
