# Environment Doctor: project preflight profiles

These are example profile inputs, not production-tested compatibility matrices. Version floors must be supplied from each project's actual lockfile or support documentation. Nothing here authorizes a repair or hardware mutation.

## Project-specific gates

| Project | Read-only environment gate | Separately required physical acceptance |
| --- | --- | --- |
| LG G3 / Nura Linux | Windows/Linux host, Python/ADB availability when declared, attached phone USB VID:PID if independently known | Correct owner/device identity, cable/data mode, bootloader policy, explicit destructive-operation approval; **never** erase automatically |
| Debian / Windows 7 | Linux/Windows OS, USB VID:PID and disk/volume GUID enumeration | Actual installer media and boot, partition backup/recovery; no write/format in Doctor |
| GuardAdaptive | Windows host, Rust/Node version, PnP VID:PID of the target controller | Physical stick drift, axes/buttons, disconnect/reconnect and before/after comparison |
| Syntavra | Windows Hyper-V/WSL/Docker versions and service, Python toolchain | Real guest launch, GPU passthrough if relevant and failover |
| ReVoltVPN | Adapter state, configured DNS server count, installed Git/Node | Distinct external DNS/TCP reachability and tunnel lifecycle under authorized network policy |
| Crypto model bot | NVIDIA/driver/VRAM, advertised CUDA toolkit compatibility, Python distribution metadata and declared minima | One known-safe CUDA kernel/framework import and bounded live model inference under separately authorized execution |
| PSMatrix | Windows OS, PowerShell environment, Git/Node/Rust as specified | Actual target shell policy and process-tree cleanup under controlled lab conditions |

## Example commands

From repo root on Windows:

```powershell
node --import tsx scripts/run-environment-doctor.ts --tool=rust:1.82 --tool=git:2.40
node --import tsx scripts/run-environment-doctor.ts --wsl-distro=Ubuntu-24.04 --usb-vid-pid=248A:8367
node --import tsx scripts/run-environment-doctor.ts --require-nvidia --min-vram-mib=9000 --python-package=torch:2.5
```

The sample VID:PID is an observed **Work PC** device, not a claimed identity for LG G3, gamepad or another target. The 9000 MiB threshold is only an example. A missing `nvcc` does not by itself rule out a PyTorch CUDA runtime. Metadata checks do not load GPU libraries or prove binary ABI compatibility. A `ready=true` value only means **the declared static preflight** passed. It does not mark `physicalAcceptance` as passed.

The live Doctor is opt-in and does not start WSL distributions, VMs, install dependencies, change accounts, format devices or modify drivers. Physical acceptance is a distinct authorized workflow whose evidence must be stored with device identity, operator approval, test method, timestamp and results.
