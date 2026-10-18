# Environment Doctor v1 (P1)

This is an opt-in, standalone, read-only diagnostic CLI and library. It is not registered as an Agent, MCP or privileged Broker tool. Existing permissions are unchanged.

## Usage

From repository root:

```powershell
node --import tsx scripts/run-environment-doctor.ts --require-nvidia --require-cuda --min-vram-mib=8192 --tool=python:3.11 --python-package=torch:2.5
```

Other flags: --require-wsl, --wsl-distro=Ubuntu-22.04, --usb-vid-pid=1234:ABCD, --require-hyperv, --tool=node:22, --tool=rust:1.82, --tool=git:2.40, --tool=docker:24, --tool=ollama:0.5, and repeatable --python-package=NAME:MINIMUM_VERSION.

With no required versions, unavailable optional tools are warnings. Requirements that are not conclusively satisfied set ready=false and CLI exit code 2. Invalid arguments use exit code 3. JSON is printed to stdout; probe stderr is never included in the report.

## Evidence contract

- `origin=live_readonly` is host-observed and is allowed **only** when Doctor creates the OS probe runner internally. Any explicitly injected runner is always `synthetic_fixture`, regardless of its constructor/prototype or its claimed origin. Rejected provenance combinations fail before any probe executes. Fixtures are not machine acceptance, even if individual simulated checks have `status=pass` or `ready=true`.
- Live probes require the actual host platform and architecture. A caller cannot override live platform, architecture, origin or generated-at clock; mismatched values fail closed. Synthetic fixtures may describe simulated Windows/Linux/USB/GPU inventories, but the resulting report remains clearly marked synthetic and physical acceptance remains `not_tested`.
- The cross-platform negative test deliberately requests a platform **different** from the current host; requesting `linux` on a Linux CI runner is legitimate and cannot be used as a rejection test. GitHub `test (22)` run #39150689903 exposed this test defect (`Missing expected rejection`).
- Each check includes name, required, status, stable code, probe IDs, a bounded observation, and an optional remediation plan with approvalRequired=true, execution=manual_only.
- Error codes include OK, MISSING_DEPENDENCY, DRIVER_NOT_STARTED, DEVICE_NOT_PRESENT, VERSION_MISMATCH, PERMISSION_REQUIRED, UNSUPPORTED_HARDWARE, VIRTUALIZATION_DISABLED, SERVICE_NOT_RUNNING, PROBE_FAILED, PROBE_TIMED_OUT, INSUFFICIENT_EVIDENCE and PHYSICAL_TEST_REQUIRED.
- A specific USB VID/PID requirement fails as DEVICE_NOT_PRESENT when it cannot be enumerated, and on Windows DRIVER_NOT_STARTED when PnP status is not OK. An expected WSL distro must be in the `wsl --list --verbose` output; this still does not prove it can boot.
- The four physicalAcceptance gates (USB, gamepad, phone, virtual_machine) remain NOT_TESTED regardless of synthetic tests or enumerated devices. True functional acceptance requires an independently recorded real device test.

## Read-only evidence sources

| Area | Source | Boundary |
| --- | --- | --- |
| Windows OS | Win32_OperatingSystem CIM | OS/version observation only |
| Python | python --version; importlib.metadata.version | No project/module imports, no package installation |
| Node/Rust/Git | Current Node runtime, rustc, git version | Read-only version metadata |
| Docker | docker --version and docker info | CLI version is distinct from daemon health |
| NVIDIA GPU/VRAM | nvidia-smi query, Win32_VideoController fallback | Total VRAM; no kernel or stress testing |
| CUDA | nvcc version and nvidia-smi advertised maximum | Version consistency only; runtime execution NOT tested |
| Hyper-V | Win32_Processor/Win32_ComputerSystem CIM | Firmware, SLAT and hypervisor flags, no VM boot |
| WSL | wsl.exe --list --verbose | No distro startup |
| USB | Windows Get-PnpDevice -PresentOnly or Linux lsusb | Only VID/PID and class/status, no device serial or writes |
| Volumes | Win32_Volume.DeviceID or lsblk | Windows Volume GUID not drive letter alone; no mount/partition/format |
| Network | Get-NetAdapter or ip -json link; DNS server config | No external DNS/TCP/internet reachability assertion; DNS addresses are not emitted |
| Linux OS | /etc/os-release and uname | No distro changes |
| Ollama | ollama --version | No models loaded |

## Hardware acceptance boundaries

VID/PID/PnP presence does not prove a USB cable, phone, gamepad, or adapter functions. Installed Hyper-V/WSL features do not prove that a guest can boot. A CUDA driver and toolkit version match does not prove framework ABI compatibility or CUDA runtime functionality. Python package compatibility is limited to declared minimum metadata versions, not importing user packages. Missing nvcc alone is not proof that a CUDA runtime is unavailable.

Prohibited automatic operations: BIOS flash, bootloader erase, disk format, partition changes, driver uninstall, UEFI edits and privilege escalation. Any possible repair is a non-executable text plan that requires explicit user approval in another workflow.

## Acceptance checklist

1. Run the synthetic unit test and TypeScript/build.
2. Run the read-only CLI locally on the intended device with a workload-specific minimum matrix.
3. Keep the JSON evidence and separately record actual USB/gamepad/phone/VM physical procedures, measured outputs and technician/owner approval.
4. Apply repairs only through a separate authorized change flow. Rerun the diagnostic afterward.
