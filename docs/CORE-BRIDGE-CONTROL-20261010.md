# CORE Access and Admin Bridge modes

This change adds visible owner-managed preferences, not unrestricted OS privileges.

## CORE Access
- The device card exposes a clickable CORE shortcut, which opens PC Settings and focuses the CORE controls.
- The owner can opt in after typing `CORE UNLIMITED`. A successful request stores a time-unbounded preference, not a Windows elevation credential.
- Activation requires FULL, an online paired device, Broker-mode telemetry and a ready Admin Bridge. Effective status pauses if these conditions disappear.
- SAFE, re-pairing or choosing Bridge OFF revoke CORE. A disabled preference cannot silently reactivate.
- Broker authorization, OAuth, Windows UAC, Windows token/ACL checks and audit requirements remain separate and mandatory.
- API: `POST /api/v1/me/devices/core-preference`; enable requires header `X-Nexowire-Confirm: core-preference-v1` and exact `confirmation: CORE UNLIMITED`.

## Admin Bridge desired mode
- PC Settings exposes AUTO, AÇ and KAPAT buttons.
- The choice is persisted per owner/device and shown as a **desired mode only**. `applied: false` is intentional.
- No Cloudflare HTTP request in this change directly starts, stops, installs, elevates or disables a Windows service.
- API: `POST /api/v1/me/devices/bridge-preference`, header `X-Nexowire-Confirm: bridge-preference-v1`, body `{deviceId,mode}` where `mode` is `auto`, `on` or `off`.
- Actual Broker readiness is still reported from existing device presence telemetry independently of the desired mode.
- The signed, owner-bound, auditable device-side action and acknowledgement path belongs to #323. It must validate actual process ownership and postconditions.

## Migration and rollout
Apply D1 migrations `0014_device_maintenance_preferences.sql` and `0015_device_bridge_preferences.sql` before deploying the new control-plane backend. The migrations also add change-audit event tables.

Do not enable a live privileged cutover until the legacy elevated ProgramData write exposure in #271 has been resolved and accepted on a real Windows machine. A green CI run or a visible CORE badge is **not** proof of that condition.
