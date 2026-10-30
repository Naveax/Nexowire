# Native consent transport scope and signer custody

The native approval client and independent readback verifier previously retained
caller-owned challenge/binding objects across the network await. The response
comparison could follow a changed owner, generation, Windows SID/LUID or receipt;
the request digest still rejected those substituted scope responses in the
baseline regression. The shared transport read the mutable signing pin after awaiting the
response, allowing a replacement pin to become the verification identity.

Requests now have a detached, deeply frozen canonical JSON snapshot before any
network call. The request digest, transmitted bytes and response verification
use that same snapshot. Origin, credential, signing pin, timeout and transport
are captured before awaiting. Agent approval and D1 readback compare against
their original detached scopes. Requests are bounded to 16 KiB and depth 32.

Four behavioral regressions check these aliases on exact parent
`c853b733ef1abfb0c937d6b3135ea112887daed9`: the pin substitution was incorrectly
accepted, and a valid original response was rejected after unrelated caller
mutation. Owner/session and Windows identity substitution were already denied.
The correction preserves those denials, rejects the replaced signing identity
and accepts only the valid response bound to the original immutable request.
The snapshot regression also checks nested immutability, cycles and size limits.

All signing keys, responses and HTTP functions in these tests are explicitly
test fixtures. No native consent service, Windows approval, independently
operated verifier, receipt ledger, trust provisioning or physical acceptance
is created by this change. The service and verifier remain uninstalled and
unwired; `CORE_EXECUTOR_DISPATCH_ENABLED=false` remains. No live installation,
UAC, task, ACL, service, VM, credential or enrollment operation is performed.
