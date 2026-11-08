import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runEnvironmentDoctor,
  type CommandProbe,
  type DoctorCheck,
  type DoctorRequirements,
  type ProbeResult,
  type ProbeRunner,
} from "../../../src/diagnostics/environment-doctor.js";

const ok = (stdout: string): ProbeResult => ({ exitCode: 0, stdout });
const unavailable: ProbeResult = { exitCode: null, stdout: "", errorCode: "ENOENT" };
const linux: Readonly<Record<string, ProbeResult>> = {
  os: ok('NAME="Test Linux"\nVERSION_ID="24.04"'),
  node: ok("v24.3.0"),
  python: ok("Python 3.12.7"),
  git: ok("git version 2.48.0"),
  volumes: ok('{"blockdevices":[]}'),
  network: ok('[]'),
  dns_config: ok("nameserver 192.0.2.53"),
};
const windows: Readonly<Record<string, ProbeResult>> = {
  os: ok('{"Caption":"Windows 11","Version":"10.0.26100"}'),
  node: ok("v24.3.0"),
  python: ok("Python 3.12.7"),
  git: ok("git version 2.48.0.windows.1"),
  hyperv: ok('{"VirtualizationFirmwareEnabled":true,"SLAT":true,"HypervisorPresent":false}'),
  wsl: ok("  NAME      STATE     VERSION\n* Ubuntu    Stopped   2"),
  volumes: ok("[]"),
  network: ok("[]"),
  dns_config: ok("[]"),
};

async function diagnose(platform: "linux" | "win32", evidence: Readonly<Record<string, ProbeResult>>,
  requirements: DoctorRequirements = {}) {
  const calls: CommandProbe[] = [];
  const runner: ProbeRunner = {
    async run(probe) {
      calls.push(probe);
      return evidence[probe.id] ?? unavailable;
    },
  };
  const result = await runEnvironmentDoctor({
    platform, architecture: "synthetic-test", origin: "synthetic_fixture",
    now: () => new Date("2026-11-07T00:00:00.000Z"), requirements,
  }, runner);
  const check = (name: DoctorCheck["name"]): DoctorCheck => {
    const found = result.checks.find((entry) => entry.name === name);
    assert.ok(found, `missing ${name} diagnostic`);
    return found;
  };
  return { result, calls, check };
}

test("T-385: Linux does not pretend to probe optional Windows-only features", async () => {
  // Even if a fixture contains Windows results, the Linux probe plan must not run them.
  const { result, check, calls } = await diagnose("linux", { ...linux, ...windows,
    os: linux.os!, hyperv: windows.hyperv!, wsl: windows.wsl! });
  for (const name of ["wsl", "hyperv"] as const) {
    assert.deepEqual({ status: check(name).status, code: check(name).code,
      required: check(name).required, evidence: check(name).evidence }, {
      status: "not_tested", code: "INSUFFICIENT_EVIDENCE", required: false, evidence: [],
    });
    assert.equal(calls.some((probe) => probe.id === name), false,
      `Linux must not run ${name} inventory`);
  }
  assert.equal(result.ready, true, "unrequested Windows-only gates must not block Linux readiness");
  assert.equal(result.origin, "synthetic_fixture");
});

test("T-385: an explicit Windows-only requirement on Linux is FAIL, not NOT_RUN", async () => {
  const scenarios: { requirements: DoctorRequirements; failing: readonly ("wsl" | "hyperv")[] }[] = [
    { requirements: { requireWsl: true }, failing: ["wsl"] },
    { requirements: { wslDistros: ["Ubuntu"] }, failing: ["wsl"] },
    { requirements: { requireHyperV: true }, failing: ["hyperv"] },
    { requirements: { requireWsl: true, requireHyperV: true }, failing: ["wsl", "hyperv"] },
  ];
  for (const { requirements, failing } of scenarios) {
    const { result, check, calls } = await diagnose("linux", linux, requirements);
    assert.equal(result.ready, false);
    for (const name of ["wsl", "hyperv"] as const) {
      const expected = failing.includes(name);
      assert.equal(check(name).required, expected);
      assert.equal(check(name).status, expected ? "fail" : "not_tested");
      assert.equal(check(name).code, expected ? "UNSUPPORTED_HARDWARE" : "INSUFFICIENT_EVIDENCE");
      assert.equal(calls.some((probe) => probe.id === name), false);
    }
  }
});

test("T-385: a missing required Windows probe is UNKNOWN, not proven unsupported", async () => {
  const { result, check, calls } = await diagnose("win32", { ...windows, hyperv: unavailable },
    { requireHyperV: true });
  assert.equal(check("hyperv").status, "unknown");
  assert.equal(check("hyperv").code, "MISSING_DEPENDENCY");
  assert.equal(check("hyperv").required, true);
  assert.ok(calls.some((probe) => probe.id === "hyperv"));
  assert.equal(result.ready, false, "unknown required evidence never grants readiness");
});

test("T-385: observed Windows incompatibility is FAIL only when it is required", async () => {
  const absentFirmware = {
    ...windows,
    hyperv: ok('{"VirtualizationFirmwareEnabled":false,"SLAT":true,"HypervisorPresent":false}'),
  };
  const optional = await diagnose("win32", absentFirmware);
  assert.equal(optional.check("hyperv").status, "warning");
  assert.equal(optional.check("hyperv").code, "VIRTUALIZATION_DISABLED");
  assert.equal(optional.result.ready, true);
  const required = await diagnose("win32", absentFirmware, { requireHyperV: true });
  assert.equal(required.check("hyperv").status, "fail");
  assert.equal(required.check("hyperv").code, "VIRTUALIZATION_DISABLED");
  assert.equal(required.result.ready, false);
  assert.equal(required.result.physicalAcceptance.find((x) => x.subject === "virtual_machine")?.status,
    "not_tested", "firmware inventory is never a real VM boot test");
});

test("T-385: Windows WSL inventory PASS does not promote distro boot or physical acceptance", async () => {
  const { result, check } = await diagnose("win32", windows, {
    requireWsl: true, wslDistros: ["Ubuntu"], requireHyperV: true,
  });
  assert.equal(check("wsl").status, "pass");
  assert.equal(check("wsl").observed?.distroBootTested, false);
  assert.equal(check("hyperv").status, "pass");
  assert.equal(check("hyperv").observed?.vmBootTested, false);
  assert.equal(result.ready, true);
  assert.ok(result.physicalAcceptance.every((gate) => gate.status === "not_tested" &&
    gate.code === "PHYSICAL_TEST_REQUIRED"));
});

test("T-385: unrequested package checks are NOT_RUN; required missing metadata is UNKNOWN", async () => {
  const optional = await diagnose("linux", linux);
  assert.equal(optional.check("python_packages").status, "not_tested");
  assert.equal(optional.check("python_packages").required, false);
  assert.equal(optional.calls.some((probe) => probe.id === "python_packages"), false);
  const required = await diagnose("linux", linux, { pythonPackages: { pip: "24.0" } });
  assert.equal(required.check("python_packages").status, "unknown");
  assert.equal(required.check("python_packages").required, true);
  assert.equal(required.check("python_packages").code, "MISSING_DEPENDENCY");
  assert.equal(required.result.ready, false);
  assert.ok(required.calls.some((probe) => probe.id === "python_packages"));
});
