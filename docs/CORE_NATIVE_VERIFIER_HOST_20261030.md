# Bounded independent native enrollment verifier host

This source-only transport component follows #980. createCoreNativeVerifierServer returns an UNBOUND HTTPS server; it does not open a port, generate keys, install Windows services, grant authority or alter production composition. A protected deployment must explicitly supply its server PEM key/certificate/client CA and compose the existing createCoreNativeEnrollmentVerifierHandler with genuine ledger, native/restore witnesses, certificate-bound identity resolver and separate signer.

## Transport limits

TLS1.3 only, mandatory verified client certificate, HTTP1.1 only, no TLS tickets or renegotiation. Maximum128 explicit connections and64 active requests (defaults32/16). Fixed deadline at TCP accept, including idle peers that never send ClientHello; a separate fixed authenticated-header deadline cannot be extended by trickled bytes. Socket mapping uses the kernel endpoint tuple rather than HTTP text or Node private fields. Request execution has a bounded absolute deadline. Timeout, disconnect or overload never instructs retry and does not erase external consume/tombstone state.

Header bytes are bounded to8192. All parsed header fields are retained so late duplicate authorization headers cannot silently disappear through Node header truncation. More than32 fields is denied before handler dispatch. Expect/Continue, protocol upgrade and CONNECT cannot bypass admission. Each socket handles at most one request. Immutable PEM/limit/handler references are detached at construction. This is transport safety, not hardware enrollment or production authorization.

## Validation

Actual disposable OpenSSL CA/server/client certificates and real TCP/TLS/HTTPS sockets: combined host, enrollment verifier and native transport suite30/30 PASS, zero skips. TypeScript PASS. Tests cover valid peers, missing certificates, TLS1.2 downgrade, alias mutation, concurrent overload, slot release, absolute execution expiry, excessive headers, Expect, idle TCP connection capacity and trickled authenticated headers. Test authorities/ledger/signers remain synthetic, not physical approval.

## Still required

Protected operational certificate/key custody and revocation lifecycle, independent CAS/database/restore hosting, genuine Windows service/IPC and hardware human enrollment, publisher-signed installer, production worker/revoke drain and two-PC acceptance. No Agent/Broker runtime, main deployment or CORE flag is changed by this component.
