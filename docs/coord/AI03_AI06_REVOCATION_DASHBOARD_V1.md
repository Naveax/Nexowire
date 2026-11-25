# AI-03 → AI-06 dashboard contract v1

Existing authenticated GET /api/v1/me/dashboard adds optional per-device coreRevocation. This is informational, not an admission credential. The field is absent on older deployments; absent means UNKNOWN. Exact owner and device are selected server-side. The remote snapshot comes from device_remote_authorization joined to the current owner and device; an inactive row retains its incremented authorization epoch. No epoch is synthesized from UI, maintenance preference, physical enrollment or Broker readiness.

| Field | v1 values | Meaning |
|---|---|---|
| version | 1 | Contract version |
| source | D1_REMOTE_AUTHORIZATION | Scope of authority snapshot |
| remoteAuthorization.state | ACTIVE / REVOKED / UNKNOWN | DB row active flag only; not effective CORE |
| remoteAuthorization.authorizationEpoch | positive integer / null | Actual DB epoch; null when unknown |
| remoteAuthorization.observedAtMs | integer / null | D1 read clock; null when unknown |
| localStop | UNKNOWN | No protected device STOP readback installed |
| pendingRevoke | UNKNOWN | No protected durable local journal readback installed |
| nativeDrain | UNKNOWN | No independent OS drain receipt installed |
| effectReadback | UNKNOWN | No independent native completion proof exposed |
| nativeEvidence | NOT_AVAILABLE | Never infer any positive native outcome |

ACTIVE is not a lease or permission to execute. REVOKED means only the remote grant was fenced, not local STOP or drain. A preference OFF acknowledgement is not revocation. Missing/error/stale or scope mismatch must render UNKNOWN, not revoked/ready. For UI freshness, discard the remote snapshot after 15 seconds or a changed selected account/device; keep unresolved mutation fence and do not auto-retry.

Future v2 (not emitted): distinct verified local STOP state and durable pendingRevoke, native drain state with independent terminal proof and exact effect ID binding; every observation bound to owner/device/installation/session plus authorization epoch, timestamp, nonce and independent proof verification. Until v2 acceptance, do not show local STOP confirmed, drain complete or physical CORE active from this contract. Keep the existing local tray STOP guidance. No new remote STOP endpoint or authorization mode introduced.
