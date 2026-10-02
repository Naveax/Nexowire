# Nexowire Web shell

Provider-neutral static dashboard shell.

It intentionally has no embedded API keys, bearer tokens, billing secrets, or demo fallback data.

Expected authenticated endpoints:

- GET /api/v1/me/dashboard
- GET /api/v1/admin/overview
- /connect for the one-click device pairing flow

The static files can be hosted on a free static host. Authentication, metering, pairing, and admin authorization belong to the control-plane API and must fail closed when unavailable.
