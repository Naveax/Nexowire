# ROOT MODE · DANGER

ROOT Mode is a short-lived, signed-in device-owner maintenance authorization lease. It is not Windows SYSTEM or Unix root and cannot disable Windows UAC, ACLs, protected installer approval policy, OAuth or audit. It never creates an arbitrary admin shell. The website must require the exact ROOT DANGER phrase and X-Nexowire-Confirm: root-danger-v1 before activation.

The server accepts only the owner's device in FULL mode with a live, elevated, ready Broker and online state. A lease expires after 15 minutes by server time, not browser time. Switching to SAFE or re-pairing invalidates the lease; access by another account returns DEVICE_NOT_FOUND. An expired lease cannot be revived by a page refresh.

This first stage introduces persistence, an explicitly dangerous site workflow, server-enforced TTL, and a persistent D1 event audit for each lease grant/revoke. It does not yet grant additional Windows elevation. Each future ROOT-only maintenance tool needs its own allowlist, live lease authorization, protected Broker revalidation, and audit record. Deploy cloudflare/migrations/0011_device_root_mode_leases.sql before exposing the UI.
