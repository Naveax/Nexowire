/**
 * Read-only, separately invokable environment inventory and dependency preflight.
 * Not registered as an Agent tool and does not confer additional authority.
 */
import { spawn } from "node:child_process";
import os from "node:os";

export type DoctorCode =
  | "OK" | "MISSING_DEPENDENCY" | "DRIVER_NOT_STARTED"
  | "DEVICE_NOT_PRESENT" | "VERSION_MISMATCH" | "PERMISSION_REQUIRED"
  | "UNSUPPORTED_HARDWARE" | "VIRTUALIZATION_DISABLED" | "SERVICE_NOT_RUNNING" | "PROBE_FAILED" | "PROBE_TIMED_OUT"
  | "INSUFFICIENT_EVIDENCE" | "PHYSICAL_TEST_REQUIRED";
export type DoctorStatus = "pass" | "warning" | "fail" | "unknown" | "not_tested";
export type DoctorOrigin = "live_readonly" | "synthetic_fixture";
export type DoctorPlatform = "win32" | "linux";
export type CheckName = "os" | "python" | "python_packages" | "node" | "rust" |
  "git" | "docker" | "hyperv" | "wsl" | "nvidia" | "cuda" |
  "ollama" | "usb" | "volumes" | "network";
export interface CommandProbe {
  readonly id: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}
export interface ProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly errorCode?: string;
  readonly timedOut?: boolean;
}
export interface ProbeRunner {
  run(probe: CommandProbe): Promise<ProbeResult>;
}
export interface DoctorRequirements {
  readonly tools?: Partial<Record<"python" | "node" | "rust" | "git" | "docker" | "ollama", string>>;
  readonly pythonPackages?: Readonly<Record<string, string>>;
  readonly minGpuVramMiB?: number;
  readonly requireNvidia?: boolean;
  readonly requireCuda?: boolean;
  readonly requireWsl?: boolean;
  /** Match a named WSL distribution; enumeration alone does not verify it can boot. */
  readonly wslDistros?: readonly string[];
  /** Uppercase or lowercase 4-digit VID:PID; presence is NOT physical acceptance. */
  readonly usbVidPid?: readonly string[];
  readonly requireHyperV?: boolean;
}
export interface FixPlan {
  readonly approvalRequired: true;
  readonly execution: "manual_only";
  readonly title: string;
  readonly steps: readonly string[];
}
export interface DoctorCheck {
  readonly name: CheckName;
  readonly status: DoctorStatus;
  readonly code: DoctorCode;
  readonly required: boolean;
  readonly detail: string;
  readonly observed?: Readonly<Record<string, unknown>>;
  readonly evidence: readonly string[];
  readonly fix?: FixPlan;
}
export interface PhysicalAcceptance {
  readonly subject: "usb" | "gamepad" | "phone" | "virtual_machine";
  readonly status: "not_tested";
  readonly code: "PHYSICAL_TEST_REQUIRED";
  readonly hardwareSeen: boolean | null;
  readonly reason: string;
}
export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly origin: DoctorOrigin;
  readonly platform: DoctorPlatform;
  readonly architecture: string;
  readonly readonly: true;
  readonly permissionsChanged: false;
  readonly ready: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly physicalAcceptance: readonly PhysicalAcceptance[];
  readonly safety: {
    readonly mutatingActionsPerformed: false;
    readonly automaticRemediation: false;
    readonly prohibitedAutomaticOperations: readonly string[];
  };
}

const SAFE_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_OUTPUT = 16_384;
const COMMAND_TIMEOUT_MS = 8_000;
const POWERSHELL = "powershell.exe";

function trimOutput(text: string): string {
  return text.slice(0, MAX_OUTPUT).trim();
}
function decodeOutput(chunks: Buffer[]): string {
  const bytes = Buffer.concat(chunks);
  if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) {
    return trimOutput(bytes.toString("utf16le"));
  }
  return trimOutput(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}
/** No shell, no command interpolation, hard deadlines, no inherited stdin. */
class ReadonlyProcessRunner implements ProbeRunner {
  async run(probe: CommandProbe): Promise<ProbeResult> {
    return new Promise((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let finished = false;
      let timedOut = false;
      let errorCode: string | undefined;
      let child: ReturnType<typeof spawn>;
      const settle = (exitCode: number | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout: decodeOutput(stdout),
          stderr: decodeOutput(stderr),
          ...(errorCode ? { errorCode } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        });
      };
      try {
        child = spawn(probe.file, [...probe.args], {
          shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
      } catch (error) {
        resolve({
          exitCode: null, stdout: "", errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_ERROR",
        });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // Some process handles remain open after kill on Windows; never wait forever.
        settle(null);
      }, Math.min(Math.max(100, probe.timeoutMs), 15_000));
      child.stdout?.on("data", (buffer: Buffer) => {
        if (outBytes >= MAX_OUTPUT) return;
        const chunk = buffer.subarray(0, MAX_OUTPUT - outBytes);
        stdout.push(chunk);
        outBytes += chunk.length;
      });
      child.stderr?.on("data", (buffer: Buffer) => {
        if (errBytes >= MAX_OUTPUT) return;
        const chunk = buffer.subarray(0, MAX_OUTPUT - errBytes);
        stderr.push(chunk);
        errBytes += chunk.length;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        errorCode = error.code ?? "SPAWN_ERROR";
        settle(null);
      });
      child.on("close", (code) => settle(code));
    });
  }
}
function ps(id: string, script: string): CommandProbe {
  return {
    id, file: POWERSHELL, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; " + script],
    timeoutMs: COMMAND_TIMEOUT_MS,
  };
}
function command(id: string, file: string, ...args: string[]): CommandProbe {
  return { id, file, args, timeoutMs: COMMAND_TIMEOUT_MS };
}
function safePackages(requirements: DoctorRequirements): string[] {
  const packages = Object.keys(requirements.pythonPackages ?? {});
  if (packages.length > 48 || packages.some((name) => !SAFE_PACKAGE_NAME.test(name))) {
    throw new TypeError("Invalid or excessive Python package names");
  }
  return packages;
}
function validateRequirements(requirements: DoctorRequirements): void {
  safePackages(requirements);
  if (requirements.usbVidPid !== undefined &&
      (!Array.isArray(requirements.usbVidPid) || requirements.usbVidPid.length > 32 ||
       requirements.usbVidPid.some((x) => typeof x !== "string" || !/^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(x)))) {
    throw new TypeError("Invalid USB VID:PID requirement");
  }
  if (requirements.wslDistros !== undefined &&
      (!Array.isArray(requirements.wslDistros) || requirements.wslDistros.length > 16 ||
       requirements.wslDistros.some((x) => typeof x !== "string" || !/^[a-z0-9][a-z0-9._+-]{0,127}$/i.test(x)))) {
    throw new TypeError("Invalid WSL distribution requirement");
  }
  if (requirements.minGpuVramMiB !== undefined &&
      (!Number.isSafeInteger(requirements.minGpuVramMiB) ||
        requirements.minGpuVramMiB < 0 || requirements.minGpuVramMiB > 1_048_576)) {
    throw new TypeError("Invalid VRAM requirement");
  }
  const versions = [...Object.values(requirements.tools ?? {}), ...Object.values(requirements.pythonPackages ?? {})];
  if (versions.some((version) => typeof version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(version))) {
    throw new TypeError("Minimum versions must be numeric dotted versions");
  }
}
export function createProbePlan(platform: DoctorPlatform, requirements: DoctorRequirements = {}): readonly CommandProbe[] {
  validateRequirements(requirements);
  const plan: CommandProbe[] = [
    command("python", platform === "win32" ? "python.exe" : "python3", "--version"),
    command("node", "node", "--version"),
    command("rust", "rustc", "--version"),
    command("git", "git", "--version"),
    command("docker", "docker", "--version"),
    command("docker_daemon", "docker", "info", "--format", "{{json .ServerVersion}}"),
    command("nvidia", "nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"),
    command("nvidia_cuda", "nvidia-smi"),
    command("cuda", "nvcc", "--version"),
    command("ollama", "ollama", "--version"),
  ];
  if (platform === "win32") {
    plan.push(
      ps("os", "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture | ConvertTo-Json -Compress"),
      ps("hyperv", "$p=Get-CimInstance Win32_Processor | Select-Object -First 1 VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions; $c=Get-CimInstance Win32_ComputerSystem; [PSCustomObject]@{VirtualizationFirmwareEnabled=$p.VirtualizationFirmwareEnabled;SLAT=$p.SecondLevelAddressTranslationExtensions;HypervisorPresent=$c.HypervisorPresent} | ConvertTo-Json -Compress"),
      command("wsl", "wsl.exe", "--list", "--verbose"),
      ps("gpu_windows", "Get-CimInstance Win32_VideoController | Select-Object Name,Status | ConvertTo-Json -Compress"),
      ps("usb", "Get-PnpDevice -PresentOnly | Where-Object {$_.InstanceId -match 'VID_[0-9A-Fa-f]{4}.PID_[0-9A-Fa-f]{4}'} | Select-Object Status,Class,InstanceId | ConvertTo-Json -Compress"),
      ps("volumes", "Get-CimInstance Win32_Volume | Where-Object {$_.DeviceID -match '^\\\\\\\\\\?\\\\Volume\\{'} | Select-Object DeviceID,DriveLetter,DriveType | ConvertTo-Json -Compress"),
      ps("network", "Get-NetAdapter | Select-Object Name,Status,InterfaceDescription | ConvertTo-Json -Compress"),
      ps("dns_config", "Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress"),
    );
  } else {
    plan.push(
      command("os", "cat", "/etc/os-release"),
      command("kernel", "uname", "-r"),
      command("usb", "lsusb"),
      command("volumes", "lsblk", "--json", "--output", "NAME,TYPE,MOUNTPOINT"),
      command("network", "ip", "-json", "link", "show"),
      command("dns_config", "cat", "/etc/resolv.conf"),
    );
  }
  if (safePackages(requirements).length) {
    // -I -S -B: ignore PYTHONPATH/user site, do not run sitecustomize/.pth, do not write bytecode.
    // Distribution metadata paths are read explicitly without importing third-party packages.
    const script = "import json,sys,sysconfig,importlib.metadata as m\n" +
      "wanted={n.lower().replace(\u0027_\u0027,\u0027-\u0027).replace(\u0027.\u0027,\u0027-\u0027):n for n in sys.argv[1:]}\n" +
      "versions={n:None for n in sys.argv[1:]}\n" +
      "paths=list(set(sysconfig.get_paths()[k] for k in (\u0027purelib\u0027,\u0027platlib\u0027)))\n" +
      "for d in m.distributions(path=paths):\n" +
      " key=str(d.metadata.get(\u0027Name\u0027,\u0027\u0027)).lower().replace(\u0027_\u0027,\u0027-\u0027).replace(\u0027.\u0027,\u0027-\u0027)\n" +
      " if key in wanted: versions[wanted[key]]=d.version\n" +
      "print(json.dumps(versions,sort_keys=True))";
    plan.push(command("python_packages", platform === "win32" ? "python.exe" : "python3",
      "-I", "-S", "-B", "-c", script, ...safePackages(requirements)));
  }
  return plan;
}
function asJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
function asObjects(text: string): Record<string, unknown>[] {
  const value = asJson(text);
  const arr = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return arr.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
}
function versionParts(text: string): number[] | null {
  const match = text.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return match.slice(1).filter((x): x is string => x !== undefined).map(Number);
}
export function meetsMinimum(actual: string, minimum: string): boolean | null {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}
function planFor(code: DoctorCode, name: string): FixPlan | undefined {
  const plans: Partial<Record<DoctorCode, FixPlan>> = {
    MISSING_DEPENDENCY: { title: "Eksik bağımlılığı doğrula ve kurulum öner", approvalRequired: true,
      execution: "manual_only", steps: [name + " için resmi üretici paketini ve hedef işletim sistemini doğrulayın.", "Kurulum/değişiklik öncesinde kullanıcı onayı alın; Doctor hiçbir şey yüklemez."] },
    DEVICE_NOT_PRESENT: { title: "Aygıt bağlantısını fiziksel doğrula", approvalRequired: true,
      execution: "manual_only", steps: ["VID/PID, PnP ve kablo/port bağlantısını cihaz sahibiyle doğrulayın.", "Sürücü kaldırma veya cihaz firmware değişikliği otomatik yapılmaz."] },
    SERVICE_NOT_RUNNING: { title: "Servis kullanılabilirliğini incele", approvalRequired: true,
      execution: "manual_only", steps: ["Servis ve daemon loglarını salt-okunur inceleyin.", "Servis başlatma/yeniden başlatma için ayrıca izin alın."] },
    DRIVER_NOT_STARTED: { title: "Sürücü/servis durumunu manuel incele", approvalRequired: true,
      execution: "manual_only", steps: ["Aygıt Yöneticisi veya servis yöneticisi üzerinden sürücü durumunu inceleyin.", "Yeniden başlatma, sürücü kurulumu veya kaldırma için ayrıca onay alın."] },
    VERSION_MISMATCH: { title: "Uyumlu sürüm planı", approvalRequired: true,
      execution: "manual_only", steps: ["Projenin desteklediği sürüm matrisini resmi kaynaklarla karşılaştırın.", "Mevcut ortamı silmeden izole güncelleme/venv hazırlamayı değerlendirin."] },
    PERMISSION_REQUIRED: { title: "Eksik izni incele", approvalRequired: true,
      execution: "manual_only", steps: ["Tam olarak hangi sistem izninin gerektiğini yerel yöneticiyle doğrulayın.", "Kapsamlı yükseltme yerine en dar yetki için açık onay isteyin."] },
    UNSUPPORTED_HARDWARE: { title: "Donanım sınırını değerlendir", approvalRequired: true,
      execution: "manual_only", steps: ["Minimum gereksinim ile doğrulanmış donanımı karşılaştırın.", "Alternatif iş yükü veya uyumlu cihaz kullanımı için onay alın."] },
    VIRTUALIZATION_DISABLED: { title: "Firmware sanallaştırmasını incele", approvalRequired: true,
      execution: "manual_only", steps: ["UEFI/BIOS sanallaştırma desteğini üretici dökümanıyla doğrulayın.", "Firmware değişikliği ya da yeniden başlatma yapmadan önce açık onay alın."] },
  };
  return plans[code];
}
function check(name: CheckName, status: DoctorStatus, code: DoctorCode, required: boolean,
  detail: string, evidence: string[], observed?: Readonly<Record<string, unknown>>): DoctorCheck {
  return { name, status, code, required, detail, evidence,
    ...(observed ? { observed } : {}), ...(planFor(code, name) ? { fix: planFor(code, name)! } : {}) };
}
function missing(result: ProbeResult | undefined): boolean {
  return !result || result.errorCode === "ENOENT";
}
function failedCode(result: ProbeResult | undefined): DoctorCode {
  if (missing(result)) return "MISSING_DEPENDENCY";
  if (result?.timedOut) return "PROBE_TIMED_OUT";
  if (/access is denied|permission denied|accessdenied|unauthorized/i.test(result?.stderr ?? "")) {
    return "PERMISSION_REQUIRED";
  }
  return "PROBE_FAILED";
}
function optionalStatus(required: boolean): DoctorStatus { return required ? "fail" : "warning"; }
function toolCheck(name: CheckName, result: ProbeResult | undefined, required: boolean,
  minimum?: string): DoctorCheck {
  if (!result || result.exitCode !== 0) {
    const code = failedCode(result);
    return check(name, code === "PROBE_FAILED" || code === "PROBE_TIMED_OUT" ? "unknown" : optionalStatus(required),
      code, required, "Çalıştırılabilir sürüm doğrulanamadı.", [name]);
  }
  const version = versionParts(result.stdout)?.join(".");
  if (!version) {
    return check(name, "unknown", "INSUFFICIENT_EVIDENCE", required, "Sürüm çıktısı tanınmadı.", [name]);
  }
  if (minimum) {
    const valid = meetsMinimum(version, minimum);
    if (valid === false) return check(name, optionalStatus(required), "VERSION_MISMATCH",
      required, "Kurulu sürüm minimumdan eski.", [name], { installed: version, minimum });
  }
  return check(name, "pass", "OK", required, "Sürüm doğrulandı.", [name],
    { installed: version, ...(minimum ? { minimum } : {}) });
}
function summaryInventory(name: CheckName, result: ProbeResult | undefined, platform: DoctorPlatform,
  requirements: DoctorRequirements, dnsConfig?: ProbeResult): DoctorCheck {
  const required = name === "usb" && !!requirements.usbVidPid?.length;
  if (!result || result.exitCode !== 0) {
    const code = failedCode(result);
    return check(name, code === "MISSING_DEPENDENCY" ? optionalStatus(required) : "unknown", code,
      required, "Envanter doğrulanamadı.", [name]);
  }
  if (name === "usb") {
    if (platform === "win32" && result.stdout.trim() && asJson(result.stdout) === null) {
      return check(name, "unknown", "INSUFFICIENT_EVIDENCE", required,
        "USB PnP çıktısı JSON olarak ayrıştırılamadı.", [name]);
    }
    const entries = platform === "win32"
      ? asObjects(result.stdout).map((entry) => {
          const match = String(entry.InstanceId ?? "").match(/VID_([A-Fa-f0-9]{4}).PID_([A-Fa-f0-9]{4})/i);
          return match ? { vid: match[1]!.toUpperCase(), pid: match[2]!.toUpperCase(),
            pnpStatus: String(entry.Status ?? "Unknown"), class: String(entry.Class ?? "Unknown") } : null;
        }).filter((x) => x !== null)
      : [...result.stdout.matchAll(/ID ([A-Fa-f0-9]{4}):([A-Fa-f0-9]{4})/g)]
        .map((m) => ({ vid: m[1]!.toUpperCase(), pid: m[2]!.toUpperCase() }));
    const count = entries.length;
    const targets = (requirements.usbVidPid ?? []).map((x) => x.toUpperCase());
    const observed = entries.map((e) => ({ ...e, id: `${e.vid}:${e.pid}` }));
    const absent = targets.filter((target) => !observed.some((x) => x.id === target));
    const unhealthy = platform === "win32" ? targets.filter((target) =>
      !absent.includes(target) && observed.some((x) => x.id === target &&
        "pnpStatus" in x && String(x.pnpStatus).toUpperCase() !== "OK")) : [];
    const code: DoctorCode = absent.length ? "DEVICE_NOT_PRESENT" :
      unhealthy.length ? "DRIVER_NOT_STARTED" : count ? "OK" : "DEVICE_NOT_PRESENT";
    const status: DoctorStatus = code === "OK" ? "pass" : optionalStatus(required);
    return check(name, status, code, required,
      "USB/PnP envanteri okundu; bu, fiziksel işlevsellik ve sürücü işlev testi değildir.",
      [name], { count, devices: entries.slice(0, 64), truncated: count > 64,
        requiredVidPid: targets, absentVidPid: absent, unhealthyVidPid: unhealthy });
  }
  if (name === "volumes") {
    if (result.stdout.trim() && asJson(result.stdout) === null) {
      return check(name, "unknown", "INSUFFICIENT_EVIDENCE", required,
        "Disk/volume envanteri JSON olarak ayrıştırılamadı.", [name]);
    }
    const arr = platform === "win32"
      ? asObjects(result.stdout).map((e) => ({
          volumeGuid: String(e.DeviceID ?? "").match(/Volume\{[a-f0-9-]+\}/i)?.[0] ?? null,
          driveLetter: typeof e.DriveLetter === "string" ? e.DriveLetter : null,
          driveType: e.DriveType ?? null,
        }))
      : (asJson(result.stdout) as { blockdevices?: unknown[] } | null)?.blockdevices ?? [];
    return check(name, "pass", "OK", false, "Disk envanteri salt-okunur alındı; mount/format yapılmadı.",
      [name], { count: arr.length, devices: arr.slice(0, 64) });
  }
  if (name === "network") {
    if (result.stdout.trim() && asJson(result.stdout) === null) {
      return check(name, "unknown", "INSUFFICIENT_EVIDENCE", required,
        "Ağ adaptörü envanteri JSON olarak ayrıştırılamadı.", [name]);
    }
    const arr = asObjects(result.stdout);
    const linuxLinks = Array.isArray(asJson(result.stdout)) ? asObjects(result.stdout) : [];
    const adapters = platform === "win32"
      ? arr.map((e) => ({ name: String(e.Name ?? ""), status: String(e.Status ?? "") }))
      : linuxLinks.map((e) => ({ name: String(e.ifname ?? ""), status: String(e.operstate ?? "unknown") }));
    const dnsServerCount = dnsConfig?.exitCode !== 0 ? null : platform === "win32"
      ? asObjects(dnsConfig.stdout).reduce((n, e) => n +
          (Array.isArray(e.ServerAddresses) ? e.ServerAddresses.length : 0), 0)
      : dnsConfig.stdout.split(/\r?\n/).filter((line) => /^\s*nameserver\s+\S+/.test(line)).length;
    return check(name, "pass", "INSUFFICIENT_EVIDENCE", false,
      "Ağ adaptörleri ve DNS yapılandırması sorgulandı; dış DNS/TCP erişimi sınanmadı.", [name, "dns_config"],
      { adapters: adapters.slice(0, 32), dnsServerCount, dnsConfigurationRead: dnsConfig?.exitCode === 0,
        internetReachabilityTested: false });
  }
  return check(name, "pass", "OK", false, "Salt-okunur envanter okundu.", [name]);
}
function gpuCheck(results: ReadonlyMap<string, ProbeResult>, requirements: DoctorRequirements,
  platform: DoctorPlatform): DoctorCheck {
  const required = !!(requirements.requireNvidia || requirements.requireCuda ||
    requirements.minGpuVramMiB !== undefined);
  const smi = results.get("nvidia");
  if (smi?.exitCode === 0 && smi.stdout) {
    const gpus = smi.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const parts = line.split(",").map((x) => x.trim());
      const vramMiB = Number(parts[1]);
      return { model: parts[0] ?? "", vramMiB: Number.isSafeInteger(vramMiB) && vramMiB > 0 ? vramMiB : null,
        driverVersion: parts[2] ?? "" };
    });
    if (!gpus.length || gpus.some((gpu) => !gpu.model || gpu.vramMiB === null ||
        !/^\d+(?:\.\d+){1,3}$/.test(gpu.driverVersion))) {
      return check("nvidia", "unknown", "INSUFFICIENT_EVIDENCE", required,
        "NVIDIA sorgusu başarılı döndü fakat GPU/model/VRAM/sürücü çıktısı eksik veya bozuk.", ["nvidia"]);
    }
    const enough = requirements.minGpuVramMiB === undefined ||
      gpus.some((gpu) => gpu.vramMiB !== null && gpu.vramMiB >= requirements.minGpuVramMiB!);
    return check("nvidia", enough ? "pass" : optionalStatus(required), enough ? "OK" : "UNSUPPORTED_HARDWARE",
      required, enough ? "NVIDIA aygıtı/sürücüsü ve bildirilen toplam VRAM okundu." : "GPU toplam VRAM gereksinimi karşılamıyor.",
      ["nvidia"], { gpus: gpus.slice(0, 16), ...(requirements.minGpuVramMiB !== undefined
        ? { requiredVramMiB: requirements.minGpuVramMiB } : {}), hardwareFunctionalTested: false });
  }
  const win = platform === "win32" ? asObjects(results.get("gpu_windows")?.stdout ?? "") : [];
  const nvidiaFound = win.some((entry) => /nvidia/i.test(String(entry.Name ?? "")));
  const code: DoctorCode = smi?.errorCode === "ENOENT" && nvidiaFound ? "MISSING_DEPENDENCY"
    : smi?.timedOut ? "PROBE_TIMED_OUT"
    : /access is denied|permission denied|unauthorized/i.test(smi?.stderr ?? "") ? "PERMISSION_REQUIRED"
    : nvidiaFound ? "DRIVER_NOT_STARTED"
    : requirements.minGpuVramMiB !== undefined && !requirements.requireNvidia && !requirements.requireCuda
      && win.length ? "INSUFFICIENT_EVIDENCE"
    : platform === "win32" && win.length ? "DEVICE_NOT_PRESENT"
    : failedCode(smi);
  return check("nvidia", code === "PROBE_TIMED_OUT" || code === "PROBE_FAILED" ||
    code === "INSUFFICIENT_EVIDENCE" ? "unknown" : optionalStatus(required),
    code, required, nvidiaFound ?
      "Windows NVIDIA adaptörü bulundu; nvidia-smi yok veya iletişim doğrulanamadı. Sürücü nedeni tek başına kanıtlanmadı." :
      "Ekran kartının kullanılabilirliği veya toplam VRAM kapasitesi doğrulanamadı.", ["nvidia", "gpu_windows"],
    { detectedVideoAdapters: win.slice(0, 12).map((entry) => ({
      model: String(entry.Name ?? ""), pnpStatus: String(entry.Status ?? ""),
    })) });
}
function cudaCheck(results: ReadonlyMap<string, ProbeResult>, requirements: DoctorRequirements): DoctorCheck {
  const required = !!requirements.requireCuda;
  const nvcc = results.get("cuda");
  const smi = results.get("nvidia_cuda");
  const toolkit = nvcc?.exitCode === 0 ? nvcc.stdout.match(/release\s+(\d+\.\d+)/i)?.[1] : undefined;
  const driverMax = smi?.exitCode === 0 ? smi.stdout.match(/CUDA Version:\s*(\d+\.\d+)/i)?.[1] : undefined;
  if (toolkit && driverMax && meetsMinimum(driverMax, toolkit) === false) {
    return check("cuda", optionalStatus(required), "VERSION_MISMATCH", required,
      "Araç seti sürümü sürücünün raporladığı maksimum CUDA API sürümünden yüksek.",
      ["cuda", "nvidia_cuda"], { installedToolkit: toolkit, reportedDriverCudaMax: driverMax });
  }
  if (toolkit && driverMax) return check("cuda", "pass", "OK", required,
    "Araç seti/sürücü bildirilen sürüm sınırı tutarlı; CUDA kernel veya yük testi yapılmadı.",
    ["cuda", "nvidia_cuda"], { installedToolkit: toolkit, reportedDriverCudaMax: driverMax, cudaExecutionTested: false });
  if (required) {
    const code = failedCode(nvcc);
    return check("cuda", code === "PROBE_FAILED" ? "unknown" : "fail",
      code === "PROBE_FAILED" ? "INSUFFICIENT_EVIDENCE" : code, required,
      "CUDA toolkit ve sürücü birlikte doğrulanamadı; nvcc bulunmaması CUDA runtime yokluğunu tek başına kanıtlamaz.",
      ["cuda", "nvidia_cuda"], { installedToolkit: toolkit ?? null, reportedDriverCudaMax: driverMax ?? null });
  }
  return check("cuda", "warning", "INSUFFICIENT_EVIDENCE", false,
    "CUDA toolkit/driver uyumluluğu tam doğrulanamadı; nvcc olmayan runtime kurulumları mümkündür.",
    ["cuda", "nvidia_cuda"], { installedToolkit: toolkit ?? null, reportedDriverCudaMax: driverMax ?? null });
}
function packagesCheck(result: ProbeResult | undefined, requirements: DoctorRequirements): DoctorCheck {
  const packages = safePackages(requirements);
  if (!packages.length) return check("python_packages", "not_tested", "INSUFFICIENT_EVIDENCE",
    false, "Python paket gereksinimi belirtilmedi.", []);
  if (!result || result.exitCode !== 0 || !asJson(result.stdout)) {
    return check("python_packages", "unknown", failedCode(result), true,
      "Python paket metadata sürümleri doğrulanamadı.", ["python_packages"]);
  }
  const installed = asJson(result.stdout) as Record<string, unknown>;
  const mismatches = packages.filter((name) => {
    const current = installed[name];
    return typeof current !== "string" || meetsMinimum(current, requirements.pythonPackages![name]!) !== true;
  });
  return check("python_packages", mismatches.length ? "fail" : "pass",
    mismatches.length ? (mismatches.some((n) => installed[n] == null)
      ? "MISSING_DEPENDENCY" : "VERSION_MISMATCH") : "OK", true,
    mismatches.length ? "Eksik/eski paket metadata tespit edildi; paketler import edilmedi." :
      "Paket metadata sürümleri karşılaştırıldı; import/çalıştırma testi yapılmadı.",
    ["python_packages"], { packageVersions: Object.fromEntries(packages.map((n) => [n, installed[n] ?? null])),
      minimumVersions: requirements.pythonPackages, mismatches });
}
export interface DoctorOptions {
  readonly platform?: DoctorPlatform;
  readonly architecture?: string;
  readonly requirements?: DoctorRequirements;
  /** Must be explicitly set to synthetic_fixture when injecting a fixture runner. */
  readonly origin?: DoctorOrigin;
  readonly now?: () => Date;
}
export async function runEnvironmentDoctor(options: DoctorOptions = {},
  runner: ProbeRunner = new ReadonlyProcessRunner()): Promise<DoctorReport> {
  const platform = options.platform ?? (process.platform as DoctorPlatform);
  if (!["win32", "linux"].includes(platform)) throw new TypeError("Unsupported doctor platform");
  const origin = options.origin ?? "live_readonly";
  if (runner.constructor !== ReadonlyProcessRunner && origin !== "synthetic_fixture") {
    throw new TypeError("Injected runner must use synthetic_fixture origin");
  }
  if (runner.constructor === ReadonlyProcessRunner &&
      (origin !== "live_readonly" || platform !== process.platform)) {
    throw new TypeError("Live runner requires actual host platform and live_readonly origin");
  }
  const requirements = options.requirements ?? {};
  const reportedArchitecture = options.architecture ?? (origin === "synthetic_fixture" ? "synthetic" : os.arch());
  const plan = createProbePlan(platform, requirements);
  const responses = new Map<string, ProbeResult>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, plan.length) }, async () => {
    while (next < plan.length) {
      const probe = plan[next++]!;
      try {
        responses.set(probe.id, await runner.run(probe));
      } catch {
        responses.set(probe.id, { exitCode: null, stdout: "", errorCode: "PROBE_ERROR" });
      }
    }
  }));
  const result = (id: string): ProbeResult | undefined => responses.get(id);
  const requiredTool = (name: "python" | "node" | "rust" | "git" | "docker" | "ollama") =>
    requirements.tools?.[name] !== undefined;
  const checks: DoctorCheck[] = [];
  const osResult = result("os");
  const osMetadata = platform === "win32" ? asObjects(osResult?.stdout ?? "")[0] :
    Object.fromEntries((osResult?.stdout ?? "").split(/\r?\n/).filter((line) => /^(NAME|VERSION_ID)=/.test(line))
      .map((line) => { const p = line.indexOf("="); return [line.slice(0, p), line.slice(p + 1).replace(/^"|"$/g, "")]; }));
  const osVerified = osResult?.exitCode === 0 && !!osMetadata &&
    (platform === "win32" ? typeof osMetadata.Version === "string" && typeof osMetadata.Caption === "string"
      : typeof osMetadata.NAME === "string");
  checks.push(osVerified ? check("os", "pass", "OK", true,
    "OS bilgisi salt-okunur alındı.", ["os"], { platform, architecture: reportedArchitecture,
      osMetadata }) : check("os", "unknown", osResult?.exitCode === 0 ? "INSUFFICIENT_EVIDENCE" : failedCode(osResult),
      true, "OS sorgusu geçerli tanımlanabilir metadata üretmedi.", ["os"]));
  for (const tool of ["python", "node", "rust", "git", "ollama"] as const) {
    checks.push(toolCheck(tool, result(tool), requiredTool(tool), requirements.tools?.[tool]));
  }
  const docker = toolCheck("docker", result("docker"), requiredTool("docker"), requirements.tools?.docker);
  const dockerDaemon = result("docker_daemon");
  checks.push(docker.status === "pass" && dockerDaemon?.exitCode !== 0
    ? check("docker", optionalStatus(requiredTool("docker")),
      /permission denied|access is denied/i.test(dockerDaemon?.stderr ?? "") ? "PERMISSION_REQUIRED" : "SERVICE_NOT_RUNNING",
      requiredTool("docker"), "Docker CLI mevcut ancak daemon yanıtı doğrulanamadı.", ["docker", "docker_daemon"], docker.observed)
    : docker);
  checks.push(packagesCheck(result("python_packages"), requirements));
  checks.push(gpuCheck(responses, requirements, platform));
  checks.push(cudaCheck(responses, requirements));
  if (platform === "win32") {
    const hv = result("hyperv");
    const obj = asObjects(hv?.stdout ?? "")[0];
    if (hv?.exitCode !== 0 || !obj) checks.push(check("hyperv", "unknown", failedCode(hv),
      !!requirements.requireHyperV, "Hyper-V/firmware özellikleri doğrulanamadı.", ["hyperv"]));
    else {
      const firmware = obj.VirtualizationFirmwareEnabled === true;
      const slat = obj.SLAT === true;
      const ready = firmware && slat;
      const ambiguousHypervisor = !ready && obj.HypervisorPresent === true;
      checks.push(check("hyperv", ready ? "pass" : ambiguousHypervisor ? "unknown" : optionalStatus(!!requirements.requireHyperV),
        ready ? "OK" : ambiguousHypervisor ? "INSUFFICIENT_EVIDENCE" : slat ? "VIRTUALIZATION_DISABLED" : "UNSUPPORTED_HARDWARE", !!requirements.requireHyperV,
        ready ? "CPU SLAT ve firmware virtualization bildirildi; gerçek VM açılışı test edilmedi." :
          ambiguousHypervisor ? "Hypervisor etkin, ancak firmware/SLAT bayrakları güvenilir şekilde görülemiyor." :
            "Firmware virtualization veya SLAT hazır görünmüyor.", ["hyperv"],
        { firmwareVirtualization: firmware, slat, hypervisorPresent: obj.HypervisorPresent === true,
          vmBootTested: false }));
    }
    const wsl = result("wsl");
    const distros = wsl?.exitCode === 0
      ? wsl.stdout.replace(/\0/g, "").split(/\r?\n/).filter((x) =>
        x.trim() && /\s[12]\s*$/.test(x)).slice(0, 30)
      : [];
    const distroNames = distros.map((row) => row.trim().replace(/^\*\s*/, "").split(/\s{2,}/)[0] ?? "");
    const requested = requirements.wslDistros ?? [];
    const absent = requested.filter((name) => !distroNames.some((seen) => seen.toLowerCase() === name.toLowerCase()));
    const required = !!(requirements.requireWsl || requested.length);
    const installed = distros.length > 0 && absent.length === 0;
    checks.push(wsl?.exitCode === 0 ? check("wsl", installed ? "pass" : optionalStatus(required),
      installed ? "OK" : "MISSING_DEPENDENCY", required,
      "WSL dağıtım listesi sorgulandı; dağıtım başlatılmadı.", ["wsl"],
      { distroNames, requiredDistros: requested, missingDistros: absent, distroBootTested: false }) : check("wsl",
      failedCode(wsl) === "PROBE_FAILED" ? "unknown" : optionalStatus(required),
      failedCode(wsl), required, "WSL listeleme başarısız.", ["wsl"]));
  } else {
    checks.push(check("hyperv", requirements.requireHyperV ? "fail" : "not_tested",
      requirements.requireHyperV ? "UNSUPPORTED_HARDWARE" : "INSUFFICIENT_EVIDENCE",
      !!requirements.requireHyperV, "Hyper-V Windows üzerinde desteklenir; bu Linux konukta doğrulanmadı.", []));
    const wslRequired = !!(requirements.requireWsl || requirements.wslDistros?.length);
    checks.push(check("wsl", wslRequired ? "fail" : "not_tested",
      wslRequired ? "UNSUPPORTED_HARDWARE" : "INSUFFICIENT_EVIDENCE", wslRequired,
      "WSL Windows konuk yöneticisinden sorgulanmalıdır; Linux içinde WSL dağıtımı listelenemez.", []));
  }
  checks.push(summaryInventory("usb", result("usb"), platform, requirements));
  checks.push(summaryInventory("volumes", result("volumes"), platform, requirements));
  checks.push(summaryInventory("network", result("network"), platform, requirements, result("dns_config")));
  const usbCheck = checks.find((c) => c.name === "usb");
  const usbCount = Number(usbCheck?.observed?.count ?? 0);
  const physicalAcceptance: PhysicalAcceptance[] = [
    { subject: "usb", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED",
      hardwareSeen: usbCheck?.status === "unknown" ? null :
        (usbCount > 0 && (!requirements.usbVidPid?.length || usbCheck?.status === "pass")), reason: "VID/PID ve PnP envanteri fiziksel tak-çıkar veya veri aktarımını doğrulamaz." },
    { subject: "gamepad", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED",
      hardwareSeen: null, reason: "Giriş/axis drift ve fiziksel tuş testi yapılmadı." },
    { subject: "phone", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED",
      hardwareSeen: null, reason: "ADB/fastboot veya bootloader erişimi denenmedi." },
    { subject: "virtual_machine", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED",
      hardwareSeen: null, reason: "Gerçek VM açma ve konuk işletim sistemi testi yapılmadı." },
  ];
  const ready = checks.every((entry) =>
    !entry.required || entry.status === "pass");
  return {
    schemaVersion: 1, generatedAt: (options.now?.() ?? new Date()).toISOString(),
    origin, platform, architecture: reportedArchitecture,
    readonly: true, permissionsChanged: false, ready, checks, physicalAcceptance,
    safety: {
      mutatingActionsPerformed: false, automaticRemediation: false,
      prohibitedAutomaticOperations: ["BIOS flash", "bootloader erase", "disk format",
        "driver uninstall", "UEFI changes", "partition changes"],
    },
  };
}
