import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RuntimeRef } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import {
  darwinRetirementObservation,
  stopDarwinTurn,
} from "./darwin-retirement.js";
import type { ExecutionConfig } from "./execution.js";

const target = {
  project_id: "fixture",
  machine_id: "worker",
  session: "fixture",
  generation: "binding",
  fingerprint: "fingerprint",
};
const execution: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  dataDir: "/controller",
  agentRoot: "/worker",
  gid: 42,
  user: "fixture",
  machine: "alias",
  identityFile: "/private/identity",
  knownHostsFile: "/private/hosts",
  target,
  macosCore: { python: "/bin/python3", retiredLaunchdLabel: "fixture" },
  fileHelper: { python: "/bin/python3", path: "/installed/worker-files.py" },
};
const ref: RuntimeRef = {
  machine_id: target.machine_id,
  runtime_machine: "alias",
  terminal_ref: "alias/t1",
  agent_name: "test",
  target,
  launch_generation: { run_id: "R-1", generation: "g1" },
};
const processReceipt = {
  machine: target.fingerprint,
  terminal: "g1",
  pid: 42,
  uid: 1234,
  process_group: 42,
  boot: "boot",
  start: "1:2",
};
const owner = {
  project_id: "fixture",
  assignment_id: "A-1",
  enrolled_process: processReceipt,
};
test("native observation uses only the pinned generation and worker account", async () => {
  const probe = vi.fn(async () => "exited");
  expect(await darwinRetirementObservation(execution, ref, owner, probe)).toBe(
    "exited",
  );
  expect(probe).toHaveBeenCalledWith(
    execution,
    expect.objectContaining({
      platform: "darwin",
      project: target.project_id,
      session: target.session,
      user: "fixture",
      terminal: "t1",
      agent_name: ref.agent_name,
      process: processReceipt,
    }),
  );
  probe.mockClear();
  for (const receipt of [
    { ...processReceipt, machine: "other" },
    { ...processReceipt, terminal: "next" },
  ])
    expect(
      await darwinRetirementObservation(
        execution,
        ref,
        { ...owner, enrolled_process: receipt },
        probe,
      ),
    ).toBe("unknown");
  expect(probe).not.toHaveBeenCalled();
});
test("C-667: only the kept-shell probe asks for and accepts the shell verdict", async () => {
  const probe = vi.fn(async () => "shell");
  expect(
    await darwinRetirementObservation(
      execution,
      ref,
      { ...owner, kept_shell: true },
      probe,
    ),
  ).toBe("shell");
  // Every other caller keeps the conservative kept answer.
  expect(await darwinRetirementObservation(execution, ref, owner, probe)).toBe(
    "kept",
  );
  expect(probe.mock.calls.map(([, c]) => c)).toMatchObject([
    { kept_shell: true, require_idle: false },
    { require_idle: false },
  ]);
  expect(probe.mock.calls[1]?.[1]).not.toHaveProperty("kept_shell");
});
test("Darwin kernel identity, PID reuse, kept shell, permission, timeout and changed generation", () => {
  execFileSync("python3", [
    "-IB",
    fileURLToPath(
      new URL("../test-support/darwin-retirement.py", import.meta.url),
    ),
  ]);
});

test("C-626: no-activity opt-in reaches the worker only for a system-ended turn", async () => {
  const probe = vi.fn(async () => "alive");
  await darwinRetirementObservation(
    execution,
    ref,
    { ...owner, system_finished_turn: true, unknown_activity: true },
    probe,
  );
  await darwinRetirementObservation(
    execution,
    ref,
    { ...owner, unknown_activity: true },
    probe,
  );
  await darwinRetirementObservation(
    execution,
    ref,
    { ...owner, system_finished_turn: true },
    probe,
  );
  expect(probe.mock.calls.map(([, c]) => c)).toMatchObject([
    { require_idle: true, unknown_activity: true },
    { require_idle: false },
    { require_idle: true },
  ]);
  expect(probe.mock.calls[1]?.[1]).not.toHaveProperty("unknown_activity");
  expect(probe.mock.calls[2]?.[1]).not.toHaveProperty("unknown_activity");
});

test("C-626: the enrolled-PID fallback runs one bound worker command after the last host guard", async () => {
  const transport = vi.fn(async (_e: unknown, args: string[]) => ({
    file: "ssh",
    args,
  }));
  const turn = { ...owner, system_finished_turn: true as const };
  const stop = (reply: () => Promise<string>, guard = () => true) => {
    const exec = vi.fn(reply);
    return {
      exec,
      result: stopDarwinTurn(execution, ref, turn, guard, transport, exec),
    };
  };
  const sent = stop(async () => JSON.stringify({ result: "sent", pid: 42 }));
  expect(await sent.result).toEqual({ sent: true, pid: 42 });
  const [, args] = transport.mock.calls[0]!;
  expect(args.slice(0, 3)).toEqual(["/usr/bin/python3", "-IB", "-c"]);
  expect(args[3]).toContain("os.kill(p['pid'], signal.SIGTERM)");
  expect(args[4]).toContain("def darwin_retirement");
  expect(JSON.parse(args[5]!)).toMatchObject({
    platform: "darwin",
    require_idle: true,
    process: processReceipt,
    terminal: "t1",
    generation: "g1",
  });
  expect(transport.mock.calls[0]?.[2]).toEqual({ workerRuntimeDir: true });
  // The host guard is last: when it fails nothing reaches the worker.
  const guarded = stop(
    async () => "{}",
    () => false,
  );
  expect(await guarded.result).toEqual({
    sent: false,
    reason: "guard_changed",
  });
  expect(guarded.exec).not.toHaveBeenCalled();
  const refused = stop(async () => JSON.stringify({ result: "refused" }));
  expect(await refused.result).toEqual({ sent: false, reason: "refused" });
  // Another PID, malformed output or a lost transport after the guard is not
  // proof either way: only a later exit observation settles it.
  for (const reply of [
    async () => JSON.stringify({ result: "sent", pid: 43 }),
    async () => "garbage",
    async () => {
      throw new Error("ssh lost");
    },
  ])
    expect(await stop(reply).result).toEqual({ sent: "unknown" });
  // A missing or foreign receipt never builds a worker command.
  transport.mockClear();
  for (const receipt of [
    undefined,
    { ...processReceipt, machine: "other" },
    { ...processReceipt, terminal: "next" },
  ]) {
    const { enrolled_process: _p, ...unbound } = turn;
    expect(
      await stopDarwinTurn(
        execution,
        ref,
        receipt ? { ...unbound, enrolled_process: receipt } : unbound,
        () => true,
        transport,
        vi.fn(),
      ),
    ).toEqual({ sent: false, reason: "refused" });
  }
  expect(transport).not.toHaveBeenCalled();
});

test("C-626 stop script: no-activity opt-in, busy, kept, foreign and reused PIDs", () => {
  execFileSync("python3", [
    "-IB",
    fileURLToPath(
      new URL("../test-support/darwin-turn-stop.py", import.meta.url),
    ),
  ]);
});
