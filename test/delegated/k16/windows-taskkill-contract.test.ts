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

test("#540 T-387: root exited while owned grandchild lives cannot be called a successful tree stop", async () => {
  // The parent is already gone, yet a grandchild created by that exact owned
  // process tree is still alive. The private killPidTree API can report only a
  // request result; it receives no descendant-incarnation postcondition.
  const ownedTree = {
    root: { pid: 17297, creationTime: "fixture-root-1", alive: false },
    grandchild: { pid: 17298, creationTime: "fixture-child-1", alive: true },
  } as const;
  const fixture = makeFixture({ event: "close", exitCode: 0 }, ownedTree.root.alive);
  const result = await fixture.terminate(ownedTree.root.pid);
  assert.equal(result, "requested", "taskkill exit zero gives request acknowledgement only");
  assert.equal(ownedTree.root.alive, false);
  assert.equal(ownedTree.grandchild.alive, true);
  assert.notEqual(result, "verified", "no descendant-exit postcondition was observed");
  assert.notEqual(result, "succeeded", "parent exit must not become a terminal-success label");
});

test("#540 T-387: a gone root with a live grandchild remains UNCONFIRMED on taskkill failure", async () => {
  const root = { pid: 17299, alive: false };
  const descendant = { pid: 17300, alive: true };
  const fixture = makeFixture({ event: "close", exitCode: 128 }, root.alive);
  assert.equal(await fixture.terminate(root.pid), "unconfirmed");
  assert.equal(descendant.alive, true, "the mock taskkill never touched the owned descendant");
});

test("#540 T-486: reused root PID and exit 128 cannot be mistaken for tree success", async () => {
  // The original owned shell incarnation has exited, but its numeric PID was
  // reused. A process.kill(pid, 0) liveness probe cannot identify incarnation.
  const oldOwnedShell = { pid: 17301, incarnation: "old-shell", alive: false };
  const unrelatedReplacement = { pid: 17301, incarnation: "new-unrelated", alive: true };
  const ownedGrandchild = { pid: 17302, incarnation: "old-child", alive: true };
  const fixture = makeFixture({ event: "close", exitCode: 128 }, unrelatedReplacement.alive);
  await assert.rejects(fixture.terminate(oldOwnedShell.pid), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "PROCESS_TREE_TERMINATION_UNCONFIRMED");
    assert.match((error as Error).message, /exitCode=128/);
    return true;
  });
  assert.notEqual(oldOwnedShell.incarnation, unrelatedReplacement.incarnation);
  assert.equal(oldOwnedShell.alive, false);
  assert.equal(ownedGrandchild.alive, true);
  assert.equal(fixture.fakeKillCalls, 0, "no unrelated process should be signaled by this fake runner");
});

test("#540 T-486: taskkill null exit with gone root and live child stays UNCONFIRMED", async () => {
  const ownedGrandchild = { pid: 17304, alive: true };
  const fixture = makeFixture({ event: "close", exitCode: null }, false);
  assert.equal(await fixture.terminate(17303), "unconfirmed");
  assert.equal(ownedGrandchild.alive, true);
});

test("#540 T-486: reused root PID with zero taskkill exit has REQUESTED, never verified", async () => {
  const oldOwnedShell = { pid: 17305, incarnation: "old-shell", alive: false };
  const unrelatedReplacement = { pid: 17305, incarnation: "new-unrelated", alive: true };
  const fixture = makeFixture({ event: "close", exitCode: 0 }, unrelatedReplacement.alive);
  const result = await fixture.terminate(oldOwnedShell.pid);
  assert.equal(result, "requested");
  assert.notEqual(result, "verified");
  assert.notEqual(oldOwnedShell.incarnation, unrelatedReplacement.incarnation);
});
