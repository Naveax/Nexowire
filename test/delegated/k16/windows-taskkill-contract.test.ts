import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// The real function is intentionally private and protected by the CORE owner.
// Extract and execute that exact source with a fake child process: no taskkill,
// process signal, Windows PID, Agent, or live machine is ever touched.
const processManagerSource = readFileSync(
  new URL("../../../src/agent/process-manager.ts", import.meta.url), "utf8",
);
const parsed = ts.createSourceFile("process-manager.ts", processManagerSource,
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNode = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "killPidTree");
assert.ok(functionNode, "main must still expose the private killPidTree source contract");
const executableSource = ts.transpileModule(functionNode.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type FakeOutcome = { event: "close"; exitCode: number | null } |
  { event: "error"; message: string };

function makeFixture(outcome: FakeOutcome, rootAlive: boolean) {
  const commands: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  let fakeKillCalls = 0;
  class FixtureProcessManagerError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  const sandbox = {
    process: { platform: "win32" },
    isPidAlive: (_pid: number) => rootAlive,
    ProcessManagerError: FixtureProcessManagerError,
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      commands.push({ file, args, options });
      const child = new EventEmitter() as EventEmitter & { kill(): boolean };
      child.kill = () => { fakeKillCalls++; return true; };
      queueMicrotask(() => {
        if (outcome.event === "close") child.emit("close", outcome.exitCode);
        else child.emit("error", new Error(outcome.message));
      });
      return child;
    },
    setTimeout,
    clearTimeout,
  };
  const terminate = runInNewContext(
    `${executableSource}\nkillPidTree`, sandbox,
  ) as (pid: number) => Promise<"requested" | "unconfirmed">;
  return { terminate, commands, get fakeKillCalls() { return fakeKillCalls; } };
}

test("#540 T-346: taskkill exit 1 with live root rejects, never silently succeeds", async () => {
  const fixture = makeFixture({ event: "close", exitCode: 1 }, true);
  await assert.rejects(fixture.terminate(17293), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "PROCESS_TREE_TERMINATION_UNCONFIRMED");
    assert.match((error as Error).message, /exitCode=1/);
    return true;
  });
  const commands = JSON.parse(JSON.stringify(fixture.commands)) as typeof fixture.commands;
  assert.deepEqual(commands, [{
    file: "taskkill.exe", args: ["/PID", "17293", "/T", "/F"],
    options: { windowsHide: true, stdio: "ignore" },
  }]);
  assert.equal(fixture.fakeKillCalls, 0);
});

test("#540 T-346: taskkill error with live root is an unconfirmed termination", async () => {
  const fixture = makeFixture({ event: "error", message: "fixture spawn denied" }, true);
  await assert.rejects(fixture.terminate(17294), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "PROCESS_TREE_TERMINATION_UNCONFIRMED");
    assert.match((error as Error).message, /exitCode=null/);
    return true;
  });
});

test("#540 T-347: root already gone plus failed taskkill is UNKNOWN, not success", async () => {
  const fixture = makeFixture({ event: "close", exitCode: 128 }, false);
  assert.equal(await fixture.terminate(17295), "unconfirmed");
});

test("#540 T-347: taskkill exit zero is only REQUESTED, not proof descendants exited", async () => {
  // The simulated root can still be present; the function must never use
  // a stronger "terminated"/"verified" label based on taskkill's exit alone.
  const fixture = makeFixture({ event: "close", exitCode: 0 }, true);
  assert.equal(await fixture.terminate(17296), "requested");
});
