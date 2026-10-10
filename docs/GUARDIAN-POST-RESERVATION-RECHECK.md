# Signed Hub / Guardian command revalidation after durable local reservation

Before this change, the pinned Ed25519 Hub command verifier and the privileged Guardian policy inspected a timestamp and owner facts **before** calling an asynchronous durable reservation callback. A local journal can block for seconds while another process holds a SQLite lock; the intent may expire or an owner may revoke/replace pairing and preference while the caller is waiting.

The source-only verification code now closes that gap:

- The signed Hub verifier requires an independent `nowAfterReservation:()=>Date` clock reader and runs the original strict identity/issuedAt/expiresAt validation again after the reserve callback completes. The first signed verification remains mandatory.
- The local Guardian policy fetches a second **trusted local** fact snapshot after reservation and revalidates the signed command time, device/owner/current credential, FULL win32 access, **same original owner preference revision**, exact request approval, Guardian independence, authenticated session, and Broker provenance for ON/AUTO.
- A post-commit expiry, owner/credential/permission change, or Guardian loss of trust consumes the already-created replay marker but produces a failed decision. It is never converted into permission to start/stop a task.
- Tests prove that an intent expiring at the exact deadline during the async reservation fails, a clock/owner approval change or local Guardian unhealthy state fails after reservation, and even a new matching owner approval for a newer preference revision cannot validate a command reserved against the prior revision.

**Limitations:** Callers must supply a genuinely fresh protected local clock and trusted fact readers. A mocked callback can fabricate time/owner state; unit tests are not production attestation. Local and Cloudflare D1 revocation are still not a distributed atomic transaction. Source-only code does not install a Guardian, change a Windows Scheduled Task, deploy Cloudflare, migrate D1, or remediate [P0 #271](https://github.com/Naveax/Nexowire/issues/271). Real privileged Broker ON/OFF remains disabled.
