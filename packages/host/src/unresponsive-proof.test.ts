import type {
  Assignment,
  CommandState,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import * as worker from "@cardigan/runtime-herdr";
import { afterEach, describe, expect, test, vi } from "vitest";
import { workerProof } from "./unresponsive-session.js";

// C-730 (V-3320): before closing the terminal of a remote session the worker
// must positively show the registered Agent CLI gone. A timed-out, failed,
// mismatched or missing journal read, or an incomplete terminal observation,
// never counts as "the Agent exited".
const generation = "b".repeat(32);
const target = {
  project_id: "fixture",
  machine_id: "worker",
  session: "fixture",
  fingerprint: "a".repeat(64),
  generation: "initial",
};
const ref = {
  machine_id: "worker",
  runtime_machine: "agent",
  terminal_ref: "agent/t1",
  agent_name: "fixture",
  target,
  launch_generation: { generation, run_id: "R-1" },
} as RuntimeRef;
const a = {
  id: "A-1",
  scope: "work_item",
  machine_id: ref.machine_id,
  runtime_ref: ref,
} as Assignment;
const identity = {
  machine: target.fingerprint,
  terminal: generation,
  uid: 1000,
  pid: 42,
  process_group: 42,
  start: "20",
  boot: "boot",
};
const launch = {
  generation,
  target,
  process: identity,
  runtime_ref: ref,
};
const state = (process: unknown = identity) =>
  ({
    project_id: "fixture",
    assignments: [a],
    runs: [
      {
        id: "R-1",
        assignment_id: a.id,
        launch_publication: { ...launch, process },
      },
    ],
    roles: [],
    events: [],
  }) as unknown as CommandState;
const execution = {
  mode: "agent-ssh",
  machine: "agent",
  target,
} as ExecutionConfig;
const reply = (observed: "exited" | "alive") => ({
  version: 1 as const,
  phase: "running" as const,
  observed,
  process: identity,
  project: "fixture",
  assignment: a.id,
  run: "R-1",
  generation,
  target: identity.machine,
});
const live = {
  ok: true,
  value: { process: "alive", agent: "unknown", observed_seq: 1 },
};
const notFound = { ok: false, error: { code: "runtime_not_found" } };
function runtimeWith(
  observed: unknown = { ok: true, value: "unknown" },
  status: unknown = live,
) {
  return {
    status: vi.fn(async () => status),
    observe_retirement: vi.fn(async () => observed),
    executionForRef: () => execution,
    release: vi.fn(),
  } as unknown as Runtime;
}
/** The worker's process-group probe, with only the OS answer substituted. */
function group(alive: boolean) {
  return vi
    .spyOn(worker, "agentProcessCommand")
    .mockImplementation(async (_config, argv) => ({
      file: "python3",
      args: [
        "-IB",
        "-c",
        `import os
def query(pid, sig):
    if pid == -42 and ${alive ? "True" : "False"}: return
    raise ProcessLookupError()
os.kill = query
os.geteuid = lambda: 1000
${argv[3]}`,
        ...argv.slice(-3),
      ],
    }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("before closing: positive proof that the Agent CLI is gone", () => {
  test("the journal shows the registered CLI gone while its launcher still holds the group", async () => {
    vi.spyOn(worker, "workerFiles").mockResolvedValue(reply("exited"));
    const probe = group(true);
    expect(await workerProof.agent(runtimeWith(), state(), a, ref)).toBe(
      "gone",
    );
    // The launcher's group is expected to survive until the terminal closes.
    expect(probe).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a local worker-helper timeout",
      () =>
        new worker.WorkerPreparationFailure(
          "Worker file preparation failed: exit=signal; timeout",
        ),
    ],
    [
      "an ssh failure outside the transport patterns",
      () =>
        new worker.WorkerPreparationFailure(
          "Worker file preparation failed: exit=255; unknown (stderr omitted)",
        ),
    ],
    [
      "an unreachable worker",
      () => new worker.WorkerTransportUnavailable("down"),
    ],
  ])("%s is never read as an exit", async (_case, error) => {
    vi.spyOn(worker, "workerFiles").mockRejectedValue(error());
    expect(await workerProof.agent(runtimeWith(), state(), a, ref)).toBe(
      "unknown",
    );
  });

  test("a missing or different registration is never read as an exit", async () => {
    vi.spyOn(worker, "workerFiles").mockResolvedValue(reply("exited"));
    expect(await workerProof.agent(runtimeWith(), state(null), a, ref)).toBe(
      "unknown",
    );
    expect(
      await workerProof.agent(
        runtimeWith(),
        state({ ...identity, start: "21" }),
        a,
        ref,
      ),
    ).toBe("unknown");
  });

  test("a live CLI in the journal or the terminal keeps the session", async () => {
    const files = vi
      .spyOn(worker, "workerFiles")
      .mockResolvedValue(reply("alive"));
    expect(await workerProof.agent(runtimeWith(), state(), a, ref)).toBe(
      "alive",
    );
    files.mockClear();
    expect(
      await workerProof.agent(
        runtimeWith({ ok: true, value: "alive" }),
        state(),
        a,
        ref,
      ),
    ).toBe("alive");
    expect(files).not.toHaveBeenCalled();
  });

  test("an unanswered terminal observation keeps the session even when the journal says exited", async () => {
    vi.spyOn(worker, "workerFiles").mockResolvedValue(reply("exited"));
    expect(
      await workerProof.agent(
        runtimeWith({
          ok: false,
          error: { code: "runtime_unavailable", message: "timeout" },
        }),
        state(),
        a,
        ref,
      ),
    ).toBe("unknown");
  });
});

describe("after closing: the whole session is proven gone", () => {
  test("terminal gone and no process of the launch left", async () => {
    vi.spyOn(worker, "workerFiles").mockResolvedValue(reply("exited"));
    group(false);
    expect(
      await workerProof.sessionGone(
        runtimeWith(undefined, notFound),
        state(),
        a,
        ref,
      ),
    ).toBe(true);
  });

  test("a surviving group member, a live terminal or a failed read is not an exit", async () => {
    vi.spyOn(worker, "workerFiles").mockResolvedValue(reply("exited"));
    group(true);
    expect(
      await workerProof.sessionGone(
        runtimeWith(undefined, notFound),
        state(),
        a,
        ref,
      ),
    ).toBe(false);
    vi.restoreAllMocks();
    vi.spyOn(worker, "workerFiles").mockResolvedValue(reply("exited"));
    group(false);
    expect(
      await workerProof.sessionGone(
        runtimeWith({ ok: true, value: "alive" }, live),
        state(),
        a,
        ref,
      ),
    ).toBe(false);
    vi.restoreAllMocks();
    vi.spyOn(worker, "workerFiles").mockRejectedValue(
      new worker.WorkerPreparationFailure("exit=signal; timeout"),
    );
    expect(
      await workerProof.sessionGone(
        runtimeWith(undefined, notFound),
        state(),
        a,
        ref,
      ),
    ).toBe(false);
  });
});
