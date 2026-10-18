# Environment Doctor native launch review (AI Screen #402)

Scope: DRAFT PR only. This is a request for #402 owners to review exactly one new native spawn signature; updating the manifest is an explicit count change and is not an authorization or isolation proof.

## Why a process launch is necessary

The Doctor queries Windows CIM/PnP and conventional vendor CLI versions through bounded commands. It does not introduce an Agent dispatch method, MCP capability, Broker privilege, background service, admin token, GUI interaction, or Windows desktop switch. Only the explicitly invoked local script or library entrypoint calls it.

## Sink review

- Exact source: src/diagnostics/environment-doctor.ts#spawn, one call.
- Commands are generated solely by createProbePlan from a fixed list of executable names and fixed argument vectors. Workload input is limited to numerical version constraints, validated package distribution names, and bounded VRAM minimum. There is no user-supplied shell/command field.
- Child process uses shell:false, windowsHide:true and stdio with stdin ignored. Output is bounded to 16 KiB per stream; each probe has an 8-second deadline. Aggregate concurrency is four.
- PowerShell uses -NoProfile -NonInteractive, with literal read-only CIM/PnP/network inspection commands. Python package inspection uses isolated interpreter startup (-I -S -B) and distribution metadata, not third-party imports. No program install or repair runs.
- Runner implementation is not exported. Agent tool registries and authorization dispatch remain unchanged.
- Process execution is still not hermetically proven and PATH hijacking, local shell and dependency integrity, OS permissions and vendor binary behavior remain external trust risks. A timeout can leave descendants; no Job Object containment is claimed.

## Acceptance gate

The direct-launch baseline explicitly includes one additional count for this single location so automated auditing remains useful against any later increase. It does not assert that this new sink can safely run on an AI Screen desktop. Keep the PR in DRAFT pending independent #402 review. Do not merge based only on baseline PASS or synthetic fixture results.

## Hardware safety

No BIOS flash, bootloader erase, disk formatting, partitioning, driver removal or automatic elevation is implemented. Physical USB, gamepad, phone and VM functional acceptance remains NOT_TESTED. They cannot be promoted to passing by fixture inventory.
