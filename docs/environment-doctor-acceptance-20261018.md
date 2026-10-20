# Environment Doctor acceptance evidence, 2026-10-18

Scope: observed read-only preflight, Windows Work PC; additional independent read-only commands on Naveax. This is **not** release or physical hardware acceptance.

## Work PC (actual Environment Doctor CLI)

- Executed opt-in CLI with NVIDIA and 8192 MiB minimum requirement. It returned CLI exit 2 and ready=false, correctly because the observed adapters were Radeon RX 570 Series and Parsec Virtual Display Adapter, not NVIDIA. No CUDA GPU acceptance can be claimed on this host.
- Docker CLI version probe succeeded but Docker daemon failed, reported SERVICE_NOT_RUNNING in the latest version (original smoke before classification improvement used DRIVER_NOT_STARTED).
- Windows PnP inventory read 14 HID/USB PnP entries with VID/PID/status, without retaining serials. Win32_Volume read three Volume GUIDs. WSL --list --verbose found Ubuntu-24.04 as Stopped/WSL2. Network links and DNS configuration are inventory only, not external reachability.
- A later actual CLI run required Python >=3.10 and pip >=1.0. Result: exit 0, ready=true; Python and isolated package metadata checks passed, pip distribution version 26.2.1. Missing optional NVIDIA and unavailable Docker service remained warnings.

## Naveax (independent direct OS commands, not Doctor CLI)

- OS: Microsoft Windows NT 10.0.22631.0.
- nvidia-smi reported NVIDIA GeForce RTX 3080, 10240 MiB VRAM, driver 591.59.
- python --version reported Python 3.13.5.
- wsl.exe --list --verbose reported Ubuntu-22.04, Ubuntu-22.04_restored, docker-desktop distributions as Stopped/WSL2.

## Open acceptance gates

- No USB unplug/replug, gamepad axis/button, phone/ADB/bootloader, physical disk write or actual VM boot was performed.
- No CUDA kernel, GPU memory allocation, Python ML framework import, network DNS/TCP reachability, sustained process soak or Agent/Broker deployment acceptance was performed.
- Linux behavior is covered by synthetic fixtures only. No native Linux host validation was performed.
- New direct native launch path requires independent AI Screen #402 review before merging this DRAFT.

## Continuation evidence (2026-10-18)

After initial PR review and successful original CI run `39135469895` (7/7 PASS):

- Extended preflight requirements: `--usb-vid-pid=VID:PID`, repeatable; `--wsl-distro=NAME`, repeatable; exact WSL name and Windows PnP Status checks. Missing required USB -> `DEVICE_NOT_PRESENT`; PnP unhealthy -> `DRIVER_NOT_STARTED`; missing target WSL -> `MISSING_DEPENDENCY`.
- Malformed OS, PnP, NVIDIA CSV, volume JSON and network JSON are not accepted as PASS. The live runner cannot be labeled synthetic or run against a different declared host OS. A fixture cannot claim a live origin.
- The Node version is now collected by a normal probe instead of leaking the test-runner's Node version into synthetic reports.
- Linux platform never falsely passes a Windows WSL/Hyper-V requirement.
- Physical acceptance remains `not_tested`. When a required VID/PID is missing, unrelated USB mice/keyboards no longer set target `hardwareSeen=true`.

**Work PC live Doctor CLI:**

1. `--usb-vid-pid=248A:8367 --wsl-distro=Ubuntu-24.04` -> exit 0; `ready=true`, `usb:pass:OK`, `wsl:pass:OK`.
2. `--usb-vid-pid=FFFF:FFFF --wsl-distro=Ubuntu-24.04` -> exit 2; `ready=false`, `usb:fail:DEVICE_NOT_PRESENT`.
3. `--wsl-distro=DefinitelyMissingDistro` -> exit 2; `ready=false`, `wsl:fail:MISSING_DEPENDENCY`.

**Actual WSL check (separate tool, NOT Linux Doctor CLI):** `Ubuntu-24.04` booted as WSL2; observed Linux `6.18.33.2-microsoft-standard-WSL2`, `/etc/os-release` NAME=Ubuntu, VERSION_ID=24.04, python3/git/ip binaries present. Linux Node and lsusb were not found on PATH, so no full native Linux Doctor CLI acceptance is claimed. Starting WSL as a separately authorized integration check is *not* performed by the read-only Doctor's WSL list probe.

**Acceptance status:** Synthetic regression 20 new Doctor tests plus 8 adjacent Agent/Protocol tests = 28/28 PASS. TypeScript and build PASS. No CUDA kernel, phone/gamepad physical tests, USB data-transfer or true native bare-metal Linux acceptance was performed.

## Final continuation scope

- Static profile-targeted VID/PID and WSL checks, malformed output fail-closed behavior, Node probe provenance, optional generic AMD GPU VRAM uncertainty, missing nvidia-smi vs stopped driver attribution, and Hyper-V masked capability ambiguity now have automated fixtures.
- Latest target suite: **24 Doctor-specific tests + 8 Agent/Protocol tests = 32 targeted PASS** (before final CI verification).
- Live Work PC: `--min-vram-mib=8192` returns `ready=false`, NVIDIA/VRAM `INSUFFICIENT_EVIDENCE` (not fabricated AMD memory), Hyper-V `INSUFFICIENT_EVIDENCE`, and all four physical acceptance fields stay `not_tested`.
