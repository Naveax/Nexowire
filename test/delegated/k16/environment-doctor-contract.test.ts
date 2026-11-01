import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createProbePlan,
  runEnvironmentDoctor,
  type CommandProbe,
  type DoctorOptions,
  type DoctorReport,
  type ProbeResult,
  type ProbeRunner,
} from "../../../src/diagnostics/environment-doctor.js";

const success = (stdout: string): ProbeResult => ({ exitCode: 0, stdout });
const absent: ProbeResult = { exitCode: null, stdout: "", errorCode: "ENOENT" };
const failure = (stderr: string): ProbeResult => ({ exitCode: 1, stdout: "", stderr });
const frozenTime = "2026-11-01T10:30:00.000Z";

const windows: Readonly<Record<string, ProbeResult>> = {
  os: success('{"Caption":"Windows 11","Version":"10.0.26100"}'),
  python: success("Python 3.12.7"),
  node: success("v24.3.0"),
  git: success("git version 2.48.0.windows.1"),
  docker: success("Docker version 27.0.0"),
  docker_daemon: success('"27.0.0"'),
  hyperv: success('{"VirtualizationFirmwareEnabled":true,"SLAT":true,"HypervisorPresent":false}'),
  wsl: success("  NAME      STATE     VERSION\n* Ubuntu    Stopped   2"),
  nvidia: success("NVIDIA RTX 4060, 8192, 555.99"),
  nvidia_cuda: success("Driver Version: 555.99 CUDA Version: 12.5"),
  cuda: success("Cuda compilation tools, release 12.4"),
  usb: success('[{"Status":"OK","Class":"USB","InstanceId":"USB\\\\VID_1234&PID_ABCD\\\\SERIAL-PRIVATE"}]'),
  volumes: success('[{"DeviceID":"\\\\\\\\?\\\\Volume{12345678-1234-1234-1234-123456789abc}\\\\","DriveLetter":"E:","DriveType":2}]'),
  network: success('[{"Name":"Ethernet","Status":"Up","InterfaceDescription":"PRIVATE-INTERFACE-DESCRIPTION"}]'),
  dns_config: success('[{"InterfaceAlias":"Ethernet","ServerAddresses":["192.0.2.53"]}]'),
};
const linux: Readonly<Record<string, ProbeResult>> = {
  os: success('NAME="Example Linux"\nVERSION_ID="24.04"'),
  python: success("Python 3.12.7"),
  node: success("v24.3.0"),
  git: success("git version 2.48.0"),
  usb: success("Bus 001 Device 002: ID 1234:abcd Sample device serial PRIVATE-SERIAL"),
  volumes: success('{"blockdevices":[{"name":"sda","type":"disk","mountpoint":null}]}'),
  network: success('[{"ifname":"eth0","operstate":"UP","address":"PRIVATE-MAC"}]'),
  dns_config: success("nameserver 192.0.2.53\n"),
};

class FixtureRunner implements ProbeRunner {
  readonly calls: CommandProbe[] = [];
  constructor(private readonly results: Readonly<Record<string, ProbeResult>>) {}
  async run(probe: CommandProbe): Promise<ProbeResult> {
    this.calls.push(probe);
    return this.results[probe.id] ?? absent;
  }
}

async function report(platform: "win32" | "linux", results: Readonly<Record<string, ProbeResult>>,
  overrides: Partial<DoctorOptions> = {}): Promise<DoctorReport> {
  return runEnvironmentDoctor({
    platform,
    architecture: "synthetic-test",
    origin: "synthetic_fixture",
    now: () => new Date(frozenTime),
    ...overrides,
  }, new FixtureRunner(results));
}

function check(result: DoctorReport, name: string) {
  const found = result.checks.find((entry) => entry.name === name);
  assert.ok(found, `missing ${name} diagnostic`);
  return found;
}

test("T-091: schema, output order, provenance, read-only flags and physical gates stay stable", async () => {
  const result = await report("win32", windows);
  assert.deepEqual(Object.keys(result), [
    "schemaVersion", "generatedAt", "origin", "platform", "architecture", "readonly",
    "permissionsChanged", "ready", "checks", "physicalAcceptance", "safety",
  ]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.generatedAt, frozenTime);
  assert.equal(result.origin, "synthetic_fixture");
  assert.equal(result.readonly, true);
  assert.equal(result.permissionsChanged, false);
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks.map((entry) => entry.name), [
    "os", "python", "node", "rust", "git", "ollama", "docker", "python_packages",
    "nvidia", "cuda", "hyperv", "wsl", "usb", "volumes", "network",
  ]);
  assert.deepEqual(result.physicalAcceptance.map(({ subject, status, code }) => ({ subject, status, code })), [
    { subject: "usb", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED" },
    { subject: "gamepad", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED" },
    { subject: "phone", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED" },
    { subject: "virtual_machine", status: "not_tested", code: "PHYSICAL_TEST_REQUIRED" },
  ]);
  assert.deepEqual(result.safety, {
    mutatingActionsPerformed: false,
    automaticRemediation: false,
    prohibitedAutomaticOperations: [
      "BIOS flash", "bootloader erase", "disk format", "driver uninstall",
      "UEFI changes", "partition changes",
    ],
  });
  const serialized = JSON.stringify(result, null, 2) + "\n";
  assert.deepEqual(JSON.parse(serialized), result);
  for (const entry of result.checks) {
    assert.ok(["pass", "warning", "fail", "unknown", "not_tested"].includes(entry.status));
    assert.equal(typeof entry.required, "boolean");
    assert.ok(Array.isArray(entry.evidence));
    if (entry.fix) {
      assert.equal(entry.fix.execution, "manual_only");
      assert.equal(entry.fix.approvalRequired, true);
    }
  }
});

test("T-091: CLI format and exit-code branches are pinned without invoking host probes", () => {
  const source = readFileSync(new URL("../../../scripts/run-environment-doctor.ts", import.meta.url), "utf8");
  assert.match(source, /JSON\.stringify\(report, null, 2\) \+ "\\n"/);
  assert.match(source, /if \(!report\.ready\) process\.exitCode = 2;/);
  assert.match(source, /process\.exitCode = 3;/);
  assert.match(source, /throw new TypeError\("Unknown option: " \+ arg\)/);
  assert.match(source, /if \(!report\.ready\) process\.exitCode = 2;\s*\} catch/);
});

test("T-092: failed probes never echo stderr secrets, USB serial, DNS IP, MAC or interface description", async () => {
  const secret = "SECRET_k16_unique_6b208e";
  const result = await report("win32", {
    ...windows,
    os: failure(`permission denied: ${secret}`),
    python: failure(`token=${secret}`),
    docker_daemon: failure(`Access is denied, key=${secret}`),
    nvidia: failure(`Authorization failed: ${secret}`),
    usb: success(`[{"Status":"OK","Class":"USB","InstanceId":"USB\\\\VID_1234&PID_ABCD\\\\${secret}"}]`),
    network: success(JSON.stringify([{ Name: "Ethernet", Status: "Up",
      MacAddress: secret, InterfaceDescription: "PRIVATE-INTERFACE-DESCRIPTION" }])),
  }, { requirements: { tools: { python: "3.11", docker: "25" }, requireNvidia: true } });
  const json = JSON.stringify(result);
  // Volume GUIDs are intentionally emitted by the published evidence contract;
  // credentials, PnP serials, DNS addresses, and interface descriptions are not.
  for (const privateValue of [secret, "PRIVATE-INTERFACE-DESCRIPTION", "192.0.2.53"]) {
    assert.ok(!json.includes(privateValue), `unexpected private probe field: ${privateValue}`);
  }
  assert.equal(check(result, "os").status, "unknown");
  assert.equal(check(result, "docker").code, "PERMISSION_REQUIRED");
  assert.equal(check(result, "python").required, true);
  assert.equal(result.ready, false);
});

test("T-092: thrown probe exceptions are reduced to a stable code without exposing credentials", async () => {
  const secret = "API_TOKEN=private-k16-probe-error";
  const runner: ProbeRunner = {
    async run(probe) {
      if (probe.id === "python") throw new Error(`Failed command: ${secret}`);
      return linux[probe.id] ?? absent;
    },
  };
  const result = await runEnvironmentDoctor({
    platform: "linux", origin: "synthetic_fixture",
    requirements: { tools: { python: "3.11" } }, now: () => new Date(frozenTime),
  }, runner);
  assert.equal(check(result, "python").code, "PROBE_FAILED");
  assert.equal(check(result, "python").status, "unknown");
  assert.equal(result.ready, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("T-093: absent optional tools are warnings, not fabricated passes; explicit requirements fail closed", async () => {
  const optional = await report("linux", linux);
  for (const name of ["rust", "ollama", "docker", "nvidia"]) {
    const entry = check(optional, name);
    assert.notEqual(entry.status, "pass", `${name} was not probed successfully`);
    assert.notEqual(entry.code, "OK");
    assert.equal(entry.required, false);
  }
  assert.equal(optional.ready, true, "ready describes required gates, not every optional tool");
  const required = await report("linux", linux, {
    requirements: { tools: { rust: "1.80", docker: "25" }, requireNvidia: true },
  });
  assert.equal(required.ready, false);
  assert.equal(check(required, "rust").status, "fail");
  assert.equal(check(required, "docker").status, "fail");
  assert.notEqual(check(required, "nvidia").status, "pass");
});

test("T-094: Windows/WSL inventory and Linux unsupported gates never imply hardware acceptance", async () => {
  const windowsWithoutWsl = await report("win32", { ...windows, wsl: absent }, {
    requirements: { requireWsl: true, usbVidPid: ["1234:ABCD"] },
  });
  assert.equal(check(windowsWithoutWsl, "wsl").code, "MISSING_DEPENDENCY");
  assert.equal(check(windowsWithoutWsl, "wsl").status, "fail");
  assert.equal(check(windowsWithoutWsl, "usb").status, "pass");
  assert.equal(windowsWithoutWsl.ready, false);
  const linuxUnsupported = await report("linux", linux, {
    requirements: { requireWsl: true, requireHyperV: true },
  });
  for (const name of ["wsl", "hyperv"]) {
    assert.equal(check(linuxUnsupported, name).code, "UNSUPPORTED_HARDWARE");
    assert.equal(check(linuxUnsupported, name).status, "fail");
  }
  assert.equal(check(linuxUnsupported, "network").observed?.internetReachabilityTested, false);
  assert.ok(linuxUnsupported.physicalAcceptance.every((gate) => gate.status === "not_tested"));
  assert.equal(linuxUnsupported.ready, false);
});

test("T-095: identical fixtures produce byte-identical JSON and preserve escaped adapter labels", async () => {
  const label = 'Desk "lab"\\corner\nline-two';
  const fixture = { ...windows, network: success(JSON.stringify([{ Name: label, Status: "Up" }])) };
  const first = await report("win32", fixture);
  const second = await report("win32", fixture);
  assert.equal(JSON.stringify(first, null, 2), JSON.stringify(second, null, 2));
  const json = JSON.stringify(first);
  assert.equal(json.includes("\nline-two"), false, "raw newline must be JSON escaped");
  const parsed = JSON.parse(json) as DoctorReport;
  const adapters = check(parsed, "network").observed?.adapters as { name: string }[];
  assert.equal(adapters[0]?.name, label);
  assert.ok(json.includes('\\"lab\\"'));
});

test("T-096: probe plans contain only bounded read-only inventory and reject unsafe parameters before running", async () => {
  const allow = new Set([
    "python.exe", "python3", "node", "rustc", "git", "docker", "nvidia-smi", "nvcc",
    "ollama", "powershell.exe", "wsl.exe", "cat", "uname", "lsusb", "lsblk", "ip",
  ]);
  for (const platform of ["win32", "linux"] as const) {
    const plan = createProbePlan(platform, { pythonPackages: { numpy: "1.26" } });
    assert.equal(new Set(plan.map((probe) => probe.id)).size, plan.length);
    for (const probe of plan) {
      assert.ok(allow.has(probe.file), `unexpected executable: ${probe.file}`);
      assert.ok(probe.timeoutMs > 0 && probe.timeoutMs <= 15_000);
      const args = probe.args.join(" ");
      assert.doesNotMatch(args, /\b(?:Install-|Remove-|Start-Process|Start-Service|Stop-Service|Set-|Clear-Disk|Format-Volume|Invoke-WebRequest|curl|wget|mkfs|sudo)\b/i);
      assert.ok(!args.includes("PRIVATE-SECRET"));
    }
    const packageProbe = plan.find((probe) => probe.id === "python_packages");
    assert.ok(packageProbe);
    assert.deepEqual(packageProbe.args.slice(0, 3), ["-I", "-S", "-B"]);
  }
  assert.throws(() => createProbePlan("linux", { pythonPackages: { "bad;command": "1" } }), /Invalid/);
  assert.throws(() => createProbePlan("win32", { usbVidPid: ["1234:ABCD;erase"] }), /Invalid/);
  const fake = new FixtureRunner(windows);
  await assert.rejects(runEnvironmentDoctor({ origin: "live_readonly" }, fake), /synthetic_fixture/);
  assert.equal(fake.calls.length, 0, "provenance is rejected before a probe runs");
});
