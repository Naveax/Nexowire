import assert from "node:assert/strict";
import { test } from "node:test";
import { createProbePlan, meetsMinimum, runEnvironmentDoctor,
  type CommandProbe, type ProbeResult, type ProbeRunner } from "../src/diagnostics/environment-doctor.js";

class Fake implements ProbeRunner {
  readonly seen: CommandProbe[] = [];
  constructor(private readonly responses: Record<string, ProbeResult>) {}
  async run(probe: CommandProbe): Promise<ProbeResult> {
    this.seen.push(probe);
    return this.responses[probe.id] ?? { exitCode: null, stdout: "", errorCode: "ENOENT" };
  }
}
const ok = (stdout: string): ProbeResult => ({ exitCode: 0, stdout });
const win = {
  os: ok('{"Caption":"Windows 11","Version":"10.0.26100"}'),
  hyperv: ok('{"VirtualizationFirmwareEnabled":true,"SLAT":true,"HypervisorPresent":false}'),
  python: ok("Python 3.12.2"), rust: ok("rustc 1.84.0 (abc)"),
  git: ok("git version 2.45.0.windows.1"),
  docker: ok("Docker version 27.1.1, build 123"),
  docker_daemon: ok('"27.1.1"'), ollama: ok("ollama version is 0.5.0"),
  wsl: ok("  NAME      STATE           VERSION\n* Ubuntu    Stopped         2"),
  nvidia: ok("NVIDIA GeForce RTX 4060 Ti, 16380, 555.99"),
  nvidia_cuda: ok("NVIDIA-SMI 555.99   Driver Version: 555.99   CUDA Version: 12.5"),
  cuda: ok("Cuda compilation tools, release 12.4, V12.4.99"),
  gpu_windows: ok('{"Name":"NVIDIA GeForce RTX 4060 Ti","Status":"OK"}'),
  usb: ok('[{"Status":"OK","Class":"USB","InstanceId":"USB\\\\VID_1234&PID_ABCD\\\\PRIVATE_SERIAL"}]'),
  volumes: ok('[{"DeviceID":"\\\\\\\\?\\\\Volume{12345678-1234-1234-1234-123456789abc}\\\\","DriveLetter":"E:","DriveType":2}]'),
  network: ok('[{"Name":"Ethernet","Status":"Up","InterfaceDescription":"Private Description"}]'),
  python_packages: ok('{"torch":"2.5.1","numpy":"1.26.0"}'),
};
function item(report: Awaited<ReturnType<typeof runEnvironmentDoctor>>, name: string) {
  return report.checks.find((c) => c.name === name);
}
test("read-only probe allowlist with bounded execution", () => {
  const plan = createProbePlan("win32", { pythonPackages: { torch: "2.5" } });
  const known = new Set(["python.exe", "rustc", "git", "docker", "nvidia-smi",
    "nvcc", "ollama", "powershell.exe", "wsl.exe"]);
  assert.ok(plan.every((p) => known.has(p.file) && p.timeoutMs > 0 && p.timeoutMs <= 15000));
  assert.equal(plan.length, new Set(plan.map((p) => p.id)).size);
  assert.ok(plan.every((p) => !/\b(?:Start-Process|Install-|Remove-|Clear-Disk|Format-Volume)\b/i.test(p.args.join(" "))));
});
test("Windows PnP, WSL, CUDA, GPU, VM metadata and Python packages are synthetic only", async () => {
  const fake = new Fake(win);
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture",
    requirements: { tools: { python: "3.10", node: "20", docker: "24", rust: "1.70" },
      pythonPackages: { torch: "2.4.0", numpy: "1.23.0" },
      minGpuVramMiB: 12000, requireCuda: true, requireNvidia: true,
      requireWsl: true, requireHyperV: true } }, fake);
  assert.equal(report.origin, "synthetic_fixture");
  assert.equal(report.ready, true);
  assert.equal(item(report, "nvidia")?.status, "pass");
  assert.equal(item(report, "cuda")?.status, "pass");
  assert.equal(item(report, "usb")?.observed?.count, 1);
  assert.deepEqual((item(report, "usb")?.observed?.devices as unknown[])[0],
    { vid: "1234", pid: "ABCD", pnpStatus: "OK", class: "USB" });
  assert.equal(item(report, "volumes")?.observed?.count, 1);
  assert.equal(item(report, "wsl")?.status, "pass");
  assert.equal(item(report, "python_packages")?.status, "pass");
  assert.ok(report.physicalAcceptance.every((t) => t.status === "not_tested"));
  assert.equal(report.safety.automaticRemediation, false);
  assert.equal(report.permissionsChanged, false);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_SERIAL"));
  assert.equal(fake.seen.length, createProbePlan("win32", { pythonPackages: { torch: "2.4", numpy: "1.23" } }).length);
});
test("version mismatch, low VRAM and missing packages block explicit requirements", async () => {
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture",
    requirements: { tools: { python: "3.12" }, pythonPackages: { torch: "2.5", numpy: "1.25" },
      minGpuVramMiB: 14000 } }, new Fake({ ...win, python: ok("Python 3.9.3"),
        nvidia: ok("RTX 4060 Ti, 8192, 555.99"),
        python_packages: ok('{"torch":null,"numpy":"1.21.0"}') }));
  assert.equal(report.ready, false);
  assert.equal(item(report, "python")?.code, "VERSION_MISMATCH");
  assert.equal(item(report, "nvidia")?.code, "UNSUPPORTED_HARDWARE");
  assert.equal(item(report, "python_packages")?.code, "MISSING_DEPENDENCY");
  assert.equal(item(report, "nvidia")?.fix?.approvalRequired, true);
});
test("PnP NVIDIA detected but driver not running", async () => {
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture",
    requirements: { requireNvidia: true } },
    new Fake({ ...win, nvidia: { exitCode: 1, stdout: "", stderr: "Driver failed" } }));
  assert.equal(item(report, "nvidia")?.code, "DRIVER_NOT_STARTED");
  assert.equal(report.ready, false);
});
test("Linux inventory does not leak MAC or claim functional hardware test", async () => {
  const report = await runEnvironmentDoctor({ platform: "linux", origin: "synthetic_fixture" }, new Fake({
    os: ok("NAME=Ubuntu\nVERSION_ID=24.04"),
    python: ok("Python 3.11"), rust: ok("rustc 1.83"), git: ok("git version 2.45"),
    usb: ok("Bus 001 Device 002: ID 046d:c548 Logitech"),
    volumes: ok('{"blockdevices":[{"name":"sda","type":"disk","mountpoint":null}]}'),
    network: ok('[{"ifname":"eth0","operstate":"UP","address":"PRIVATE_MAC"}]'),
  }));
  assert.equal(item(report, "usb")?.observed?.count, 1);
  assert.equal(item(report, "wsl")?.status, "not_tested");
  assert.equal(item(report, "network")?.observed?.internetReachabilityTested, false);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_MAC"));
  assert.ok(report.physicalAcceptance.every((t) => t.status === "not_tested"));
});
test("permissions errors are distinct", async () => {
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture",
    requirements: { requireHyperV: true, tools: { docker: "25" } } },
    new Fake({ ...win, hyperv: { exitCode: 1, stdout: "", stderr: "Access is denied" },
      docker_daemon: { exitCode: 1, stdout: "", stderr: "permission denied" } }));
  assert.equal(item(report, "hyperv")?.code, "PERMISSION_REQUIRED");
  assert.equal(report.checks.filter((c) => c.name === "docker").length, 1);
  assert.ok(report.checks.some((c) => c.name === "docker" && c.code === "PERMISSION_REQUIRED"));
  assert.equal(report.ready, false);
});
test("fail closed on injection without fixture provenance and invalid requirements", async () => {
  await assert.rejects(() => runEnvironmentDoctor({ platform: "win32" }, new Fake(win)), /synthetic_fixture/);
  assert.throws(() => createProbePlan("win32", { pythonPackages: { "__import__('os')": "1.0" } }), /Invalid/);
  assert.throws(() => createProbePlan("win32", { minGpuVramMiB: -1 }), /Invalid VRAM/);
});
test("semver numeric components", () => {
  assert.equal(meetsMinimum("3.12.0", "3.9"), true);
  assert.equal(meetsMinimum("1.9", "1.10"), false);
  assert.equal(meetsMinimum("v22.15.0", "22"), true);
});
test("WSL with no installed distribution cannot satisfy required WSL", async () => {
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture",
    requirements: { requireWsl: true } },
    new Fake({ ...win, wsl: ok("Windows Subsystem for Linux has no installed distributions.") }));
  assert.equal(item(report, "wsl")?.code, "MISSING_DEPENDENCY");
  assert.equal(report.ready, false);
});
test("CUDA toolkit newer than advertised driver maximum is version mismatch", async () => {
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture",
    requirements: { requireCuda: true } },
    new Fake({ ...win, cuda: ok("Cuda compilation tools, release 12.6"),
      nvidia_cuda: ok("Driver Version: 540.1 CUDA Version: 12.1") }));
  assert.equal(item(report, "cuda")?.code, "VERSION_MISMATCH");
  assert.equal(report.ready, false);
});
test("Docker client and daemon are a single result, independent from installation", async () => {
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture",
    requirements: { tools: { docker: "25" } } },
    new Fake({ ...win, docker_daemon: { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } }));
  assert.equal(report.checks.filter((c) => c.name === "docker").length, 1);
  assert.equal(item(report, "docker")?.code, "SERVICE_NOT_RUNNING");
  assert.equal(item(report, "docker")?.status, "fail");
});
test("optional DNS configuration is metadata, not verified connectivity", async () => {
  const report = await runEnvironmentDoctor({ platform: "win32", origin: "synthetic_fixture" },
    new Fake({ ...win, dns_config: ok('[{"InterfaceAlias":"Ethernet","ServerAddresses":["1.1.1.1","8.8.8.8"]}]') }));
  assert.equal(item(report, "network")?.observed?.dnsServerCount, 2);
  assert.equal(item(report, "network")?.observed?.internetReachabilityTested, false);
  assert.ok(!JSON.stringify(report).includes("8.8.8.8"));
});
