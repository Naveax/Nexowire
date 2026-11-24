# AI-03 dispatch ACK boundary

Exact #1269 base `29ce8b354f099d2171a934cb5fe24272ffba54b6`. Independent of #1270. No other ref changes.

Existing client credential lookup was unbounded, accepted any successful HTTP status for receipt/release, buffered full response before checking size, and serialized live evidence after an await. One referenced deadline now covers credential, network and bounded body; exact HTTP 200 receipt / 204 release, strict media metadata, bounded UTF-8, pre-await bytes and detached scope. No retry or effect implementation change. Test uses disposable TLS, opaque fixture receipt, no native operation. No change to signed proof semantics or authorization.

Production mTLS Broker identity, independent restore witness, protected native evidence and signed owner revoke/drain remain external dependencies. This is not a production-native provider, no deployment or device mutation. CORE hard stop and MISSING gates unchanged. Two evolved protected matrix rows require coordinator reconciliation; no CSV changes. Exact new CI required.
