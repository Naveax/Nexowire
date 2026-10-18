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
