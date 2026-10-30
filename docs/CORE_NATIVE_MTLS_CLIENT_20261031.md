# Native enrollment verifier mTLS client

User requirement: one genuine local enrollment per owned device, indefinite and revocable across normal reboot/reconnect, without recurring human approval. Network request deadlines are not enrollment lifetimes. This change is a prerequisite transport component, not completion of the protected local service or activation of either live device.

createCoreNativeMtlsFetch supplies the existing verifier adapter with a real Node HTTPS mTLS transport. Explicit client key/certificate/server CA and a server SPKI SHA256 pin are required from protected deployment. TLS1.3, normal hostname/CA validation AND the independent key pin must all pass. Origin/path/method/header/body constraints are fixed before network I/O. No redirects, automatic retries, environment proxy inheritance or fallback to bearer-only fetch. Execution/cancellation and response bytes are bounded; ambiguity remains UNKNOWN to the caller and never reopens a consumed receipt.

The factory snapshots strings/limits before awaits, accepts only the exact native verifier POST endpoint and refuses Request objects or streaming bodies. Request bytes are bounded to16384 and response bytes to32768. Request/response errors are sanitized; private credentials and OpenSSL error details are not returned. Invalid TLS material cannot leave a live deadline timer after synchronous HTTPS construction failure.

This is a Node-host component. It is not automatically wired into the Cloudflare Worker; deployment still needs an appropriate protected mTLS-capable Worker binding or independent gateway, genuine certificates/signers and existing durable ledger/native/restore witnesses. Test EC certificates and software signing keys are disposable synthetic fixtures, not production hardware or human approval.

## Evidence

TypeScript/build/whitespace PASS. Combined actual socket host, verifier handler, mTLS adapter and native transport:32/32 PASS, zero skips. The existing verifier completes authenticated consume/readback against the bounded real host without an HTTP mock, rejects replay and a wrong TLS key before ledger access. Constructor alias changes cannot replace origin/key pins. Additional actual sockets reject redirects, oversized/trickled responses, pre-aborted calls, excessive request bodies and Host substitution, with one HTTP request and no automatic retry.

## Next acceptance

Protected Windows service/IPC and genuine first human credential enrollment; durable grant identity distinct from fresh per-boot session evidence; independent revocation/restore custody; full executor/provider integration; two-device reboot/reconnect/revoke testing. No localEnrolled=true/CORE.active=true is synthesized by this change and no existing 1.0.8 installation is hot-patched.
