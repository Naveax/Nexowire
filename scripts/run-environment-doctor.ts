#!/usr/bin/env node
import { runEnvironmentDoctor, type DoctorRequirements } from "../src/diagnostics/environment-doctor.js";

function parseArgs(args: readonly string[]): DoctorRequirements {
  const tools: Record<string, string> = {};
  const pythonPackages: Record<string, string> = {};
  let minGpuVramMiB: number | undefined;
  let requireNvidia = false, requireCuda = false, requireWsl = false, requireHyperV = false;
  for (const arg of args) {
    if (arg === "--require-nvidia") requireNvidia = true;
    else if (arg === "--require-cuda") requireCuda = true;
    else if (arg === "--require-wsl") requireWsl = true;
    else if (arg === "--require-hyperv") requireHyperV = true;
    else if (arg.startsWith("--min-vram-mib=")) minGpuVramMiB = Number(arg.slice("--min-vram-mib=".length));
    else if (arg.startsWith("--python-package=")) {
      const input = arg.slice("--python-package=".length);
      const cut = input.lastIndexOf(":");
      if (cut < 1) throw new TypeError("Expected --python-package=NAME:MIN_VERSION");
      pythonPackages[input.slice(0, cut)] = input.slice(cut + 1);
    } else if (arg.startsWith("--tool=")) {
      const input = arg.slice("--tool=".length);
      const cut = input.lastIndexOf(":");
      const name = input.slice(0, cut);
      if (!["python", "node", "rust", "git", "docker", "ollama"].includes(name) || cut < 1) {
        throw new TypeError("Expected --tool=python|node|rust|git|docker|ollama:MIN_VERSION");
      }
      tools[name] = input.slice(cut + 1);
    } else throw new TypeError("Unknown option: " + arg);
  }
  return { tools, pythonPackages, ...(minGpuVramMiB === undefined ? {} : { minGpuVramMiB }),
    requireNvidia, requireCuda, requireWsl, requireHyperV };
}
try {
  const report = await runEnvironmentDoctor({ requirements: parseArgs(process.argv.slice(2)) });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!report.ready) process.exitCode = 2;
} catch (error) {
  process.stderr.write("Environment Doctor: " + (error instanceof Error ? error.message : "Unknown error") + "\n");
  process.exitCode = 3;
}
