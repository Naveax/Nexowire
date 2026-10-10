# Guardian Broker postcondition double-snapshot safeguard (source-only)

The original measured receipt took exactly one Scheduled Task reading, one local process/port inventory and (for ON/AUTO) one authenticated Broker health reading before returning `result:'applied'`. A Broker task can restart, disappear or relisten while the readings are in progress, making the first task/process snapshot obsolete.

`measureGuardianBrokerPostcondition` now performs a SECOND separate trusted local Task + process/listener audit just before it may produce a success receipt. All bounded independently authenticated evidence must parse correctly, the second task must retain the same canonical identity/state, and process/listener/recovery observations must remain consistent with the first. Incomplete, unreadable, conflicting or untrusted evidence yields only a `failed` receipt. The final observation timestamp comes from a fresh clock AFTER the second audit, and reaching the exact signed intent expiry during a slow audit rejects the success outright.

Tests cover OFF with a task changing from Disabled to Running, residual/restarted Broker processes and listeners, ON with disappearing task/untrusted final inventory, a command expiring during measurement, and honest final timestamp. Previously valid ON/OFF/AUTO synthetic signed-receipt roundtrips remain passing.

**Limitations:** Two non-atomic snapshot readings do NOT guarantee that a process cannot restart an instant after the second reading. Counts alone cannot establish process identity continuity, and the callbacks are not authenticated attestations simply because they returned fields. Production needs a separately protected Windows Guardian, secure local process/port reader with pinned executable owner/PID checks, protected task action and signed Ed25519 receipt enrollment before relying on any outcome. P0 #271 remains OPEN.

No real Windows Scheduled Task state, ACL, Agent, Worker or Cloudflare D1 data is changed. No privilege elevation or actuation code was added.
