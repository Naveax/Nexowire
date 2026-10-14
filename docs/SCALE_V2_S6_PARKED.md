# Scale v2 — S6 feature expansion is parked

> **Status: OUT OF SCOPE for current connection/capacity initiative.** Preserve the user's Nexowire EXTREME feature vision without implementing or deploying it before S1–S5 acceptance. Parent: [#482](https://github.com/Naveax/Nexowire/issues/482).

The user's wider vision is an AI-native computer operating platform, with eight major module families and optional extensions. These describe future product opportunities and do not provide current cost, security or OS support evidence.

| Future module | Preserved intent | Why parked |
| --- | --- | --- |
| SCREEN X | Human-friendly remote desktop, adaptive FPS/codec, multi-monitor, audio, file and clipboard collaboration | Needs bounded LINK transport, secure viewer sessions, bandwidth accounting and hardware acceptance first |
| BRAIN | Local computer context, semantic file search, visual diagnostics, root-cause analysis, safe AI assistance | Requires optional compute/resource/privacy budgets and explicit consent |
| GUARDIAN | Preflight, checkpoints, verifiable rollback, audit and emergency stop | Separate from #402 existing security gates; do not promise universal rollback |
| FLEET | Health, patch rings, scheduled automation, policy, device inventory and alerts | Depends on tenant authorization, quota, safe orchestration and device lifecycle |
| DEVGRID | Distributed builds, remote debug, workspace teleport, cache mesh and GitOps | Requires trusted cross-device transport, reproducibility and local capacity |
| LINK | Advanced QUIC/WebRTC, P2P, resumable/delta transfer, relay scheduling | **S1 may develop only foundational connection/transport compatibility and cost measurement**; advanced end-user LINK features remain parked |
| HARDWARE | AMT/Redfish/IPMI/PiKVM, device lab and out-of-band | Cannot be provided by a normal OS-only installer on unsupported hardware |
| SPECIAL X | TWIN, TIME MACHINE, HIVE, SHADOW, extension marketplace and policy/flight-recorder concepts | Feature productization waits for core cost, privilege and audit model |

### S6 admission gate

- [ ] S1–S5 documented acceptance completed and source/CI/deployed status verified.
- [ ] Per-user cost budgets and relay limits can sustain any proposed feature under realistic traffic.
- [ ] Security threat model, permission and cancellation/rollback semantics reviewed for chosen module.
- [ ] Feature work receives a new, separately authorized issue/PR; does not silently extend S1–S5 scope.

Until then, **focus only on reliability, connection, user quotas, signed 1–2-step onboarding, future subscription policy and load/cost proof**.
