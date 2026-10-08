# Console UI and device selection hardening (2026-10-08)

## Included
- Replaced the browser-default `<details><summary>` PC Settings link-like text with a real per-card `<button type=button>`, `aria-expanded`, unique controlled panel and inert hidden content. Badge row displays Agent version, Admin Bridge status, FULL/SAFE and ROOT independently. Grid and list layouts use the same structure.
- Added motion easing for device cards, buttons, utility disclosure and settings panel with `prefers-reduced-motion` override.
- Reused the dashboard brand and logo on `/connect.html`, added an always-visible return link, keyboard-supported Windows/macOS/Linux tabs and OS detection. The verified public v1.0.5 release links supply the Windows Setup.cmd installer and the cross-platform CLI archive. The Windows PowerShell snippet downloads only; browsers cannot automatically execute an operating-system installer. Local app callback pairing and OAuth remain unchanged.
- Renamed informational ROOT+ filter **CORE**. This is NOT an enabled privilege or actual Windows kernel access.
- Added owner-scoped AUTO preference in Cloudflare D1 migration 0013. Missing record means OFF, enabling requires the signed-in owner, typed `AUTO DEVICE ACCESS` and `X-Nexowire-Confirm: auto-device-selection-v1`. Disabling remains available at any time. The owner-specific target-resolution API does not implicitly select a single device or a single-device folder while AUTO is off; two or more candidates always demand selection, even when AUTO is on.
- MCP `resolveDevice` now fails closed when `device_id`/a recognized alias is missing, including when the credential is scoped to exactly one online device. Explicit ID must still be checked against online and credential scope. Credential scoping alone does not prove request-level consent.

## Verified boundaries / not implemented
- The separate ChatGPT-facing MCP runtime is not bound to the website's owner OAuth AUTO preference yet. It **always** requires an explicitly specified device ID, even when AUTO is on at the website. The UI states this. Do not claim website AUTO authorizes implicit MCP tool operations.
- CORE Access is a display-only future tier; do not claim unrestricted root, SYSTEM, kernel, UAC bypass, persistent elevation or an approved agreement. A later change needs owner reauthentication, signed scope consent, server lease/persistence, Broker enforcement and revocation/audit.
- Windows user still starts the verified installer, or may use the download command. macOS/Linux are CLI-based manual setup paths; one-click OS installation via website alone is not available.
- Isolated browser preview used synthetic devices only and was cleaned up. Authenticated owner production acceptance remains open.

## Checklist for future iteration
1. Browser-authenticated owner acceptance for /, /connect, AUTO on/off, D1 persistence, PC Settings keyboard navigation, CORE unavailable messaging.
2. Authenticated owner-to-MCP device mapping and explicit selection artifact, allowing default-deny AUTO only after a verified owner grant.
3. Privileged Broker/Naveax ROOT readiness diagnostic under existing Stack without restarting production workers.
4. Independent CORE Access policy and Broker capability security architecture, then owner contract and complete negative-path tests.
5. Signed native bootstrap/helper for one-click OS handoff with integrity and explicit operating-system consent.
