# AI Screen: native process launch path audit

Scope: P0 [#402](https://github.com/Naveax/Nexowire/issues/402), **DEV only**.
Baseline taken from `main` commit
`6c6c1f9cac7df6d2fd1e0dea12527a3fc15391e1` on 2026-10-14.

## What the automated audit guarantees

`npm run ai-screen:launch-audit` walks `src/**/*.ts` and
`src/**/*.tsx` and collects direct calls to `node:child_process`
(or `child_process`) `spawn`, `spawnSync`, `exec`, `execSync`,
`execFile`, `execFileSync`, and `fork`. It recognizes named
and aliased imports, namespace imports, top-level CommonJS
`require` bindings and direct `require(...).spawn(...)` calls.
Import syntax inside a string/comment does not count as a call.

The initial observation is **55 direct callsites** across
**42 source-file/function signatures**. The baseline JSON at
`scripts/ai-screen-launch-sinks-baseline.json` records counts
per filename and imported native function. During
`npm run check` on GitHub CI, a new source file using
`child_process` or any *increase* above a baseline count fails.

To add an intentional native launch sink, review the new path
for explicit `ui_target`, private-only routing or denied owner
GUI, and append an explanation to the PR before changing the
baseline. A decreased count is allowed and is reported. Existing
baseline entries are **not approvals**; they merely prevent
silent proliferation of existing native launch entry points.
Changes inside an existing sink that preserve its count also
require normal code review.

## High-priority paths that still need actual isolation validation

| File / category | Known boundary / next acceptance |
| --- | --- |
| `src/agent/process-worker.ts`, `process-manager.ts`, `windows-private-shell.ts` | Shell workers can spawn indirect children; known brokers are blocked, but compiled programs and dynamic commands are not transitively confined |
| `src/agent/browser-manager.ts` | Visible browser launches require explicit private target; headless process trees still need confinement, app callback and reattach tests |
| `src/agent/windows-private-desktop.ts` | Direct CreateProcess uses `lpDesktop`; inheriting it is not proof that COM/Explorer/UAC descendants stay off the owner's desktop |
| `src/agent/windows-installer-job.ts` | Contains PowerShell `Start-Process` and elevated installer logic; private AI calls to `windows.installer.apply` are blocked, not silently routed |
| `src/agent/windows-console-grant.ts`, lifecycle helpers, `src/update/*` | Must preserve owner consent and separate machine-maintenance paths from AI-generated GUI tasks |
| `src/agent/windows-accessibility.ts`, `windows-input.ts`, `windows-window-control.ts` | Legacy owner-Default controls remain blocked for private AI; private UIA has a separate implementation |

## Important exclusions

This is a **static AST regression check**, not an application
sandbox, a runtime provenance check, or proof that the user
desktop cannot be affected. It does **not** discover:

- PowerShell `Start-Process` or `ShellExecute` embedded in
  generated scripts (for example `windows-installer-job.ts`);
- Win32 `CreateProcess`, shell/COM operations, executable internals,
  dynamic JavaScript `Function`/`eval`, or other native libraries;
- child-process import aliases created inside arbitrary nested
  expressions or constructed at runtime;
- moving or replacing commands **within an existing** counted sink;
- transient descendants after parents exit or reused process IDs;
- Windows Session 0 limitations, independent virtual monitor isolation,
  physical owner foreground/input events or UAC on the secure desktop.

Issue #402 stays open until the broader launch-routing review,
contained/denied brokered descendants and long-running interactive
acceptance are completed. This audit makes added launch entry points
visible in code review; it does not close those requirements.
