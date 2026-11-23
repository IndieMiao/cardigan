import type {
  Assignment,
  CommandState,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import * as worker from "@cardigan/runtime-herdr";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  sessionExitProof,
  stallEvidence,
  transferredSessionExited,
} from "./stall-evidence.js";
import { stoppedSessionExited } from "./stop-run.js";

// C-663: a session whose terminal is gone and whose launch has no process
// left is exited; a live process, an unreachable worker or a missing
// registration never is.
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
  scope: "standing",
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
const state = {
  project_id: "fixture",
  assignments: [a],
  runs: [
    {
      id: "R-1",
      assignment_id: a.id,
      launch_publication: {
        generation,
        target,
        process: identity,
        runtime_ref: ref,
      },
    },
  ],
  roles: [],
  events: [],
} as unknown as CommandState;
const execution = {
  mode: "agent-ssh",
  machine: "agent",
  target,
} as ExecutionConfig;
const reply = {
  version: 1 as const,
  phase: "running" as const,
  observed: "exited" as "exited" | "alive",
  process: identity,
  project: state.project_id,
  assignment: a.id,
  run: "R-1",
  generation,
  target: identity.machine,
};
const notFound = { ok: false, error: { code: "runtime_not_found" } };

function remoteWorker(groupAlive: () => boolean) {
  const files = vi.spyOn(worker, "workerFiles").mockResolvedValue(reply);
  const group = vi
    .spyOn(worker, "agentProcessCommand")
    .mockImplementation(async (_config, argv) => {
      // Run the actual worker probe, substituting only the OS observations.
      const fixture = `import os, sys
def query(pid, sig):
    if pid == -42 and ${groupAlive() ? "True" : "False"}: return
    raise ProcessLookupError()
os.kill = query
os.geteuid = lambda: 1000
${argv[3]}`;
      return {
        file: "python3",
        args: ["-IB", "-c", fixture, ...argv.slice(-3)],
      };
    });
  return { files, group };
}
function runtimeWith(
  status: unknown,
  observed: unknown = { ok: true, value: "unknown" },
) {
  return {
    status: vi.fn(async () => status),
    observe_retirement: vi.fn(async () => observed),
    release: vi.fn(),
    retire_idle: vi.fn(),
  } as unknown as Runtime;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("C-663 remote session exit proof", () => {
  test("terminal gone and no registered process left: exited, and the waiting handoff may restart", async () => {
    const { group } = remoteWorker(() => false);
    const runtime = runtimeWith(notFound);
    expect(await sessionExitProof(state, a, runtime, execution)).toBe("exited");
    expect(await transferredSessionExited(state, a, runtime, execution)).toBe(
      true,
    );
    expect(
      await stallEvidence(state, a, runtime, execution, undefined, undefined, {
        phase: "waiting",
        started_at: "2026-11-23T00:00:00.000Z",
        queue_id: "R-2" as never,
      }),
    ).toMatchObject({ can_restart: true });
    // The worker's own process-group probe ran; nothing was signalled.
    expect(group).toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
    expect(runtime.retire_idle).not.toHaveBeenCalled();
    // The stop path reuses the same proof for a remote reference.
    expect(
      await stoppedSessionExited(
        runtime,
        ref,
        { project_id: "fixture", assignment_id: a.id },
        () => sessionExitProof(state, a, runtime, execution),
      ),
    ).toBe("exited");
  });

  test("terminal gone but the registered process or its group is still there: not exited", async () => {
    let alive = true;
    const { files } = remoteWorker(() => alive);
    const runtime = runtimeWith(notFound);
    // A surviving group member keeps the session.
    expect(await sessionExitProof(state, a, runtime, execution)).toBe(
      "unproven",
    );
    // The registered leader itself is still running.
    alive = false;
    files.mockResolvedValue({ ...reply, observed: "alive" });
    expect(await sessionExitProof(state, a, runtime, execution)).toBe(
      "process_alive",
    );
    expect(
      await stallEvidence(state, a, runtime, execution, undefined, undefined, {
        phase: "waiting",
        started_at: "2026-11-23T00:00:00.000Z",
        queue_id: "R-2" as never,
      }),
    ).toMatchObject({ can_restart: false });
    // A different process identity (PID reuse) is no proof.
    files.mockResolvedValue({
      ...reply,
      process: { ...identity, start: "other" },
    });
    expect(await sessionExitProof(state, a, runtime, execution)).toBe(
      "unproven",
    );
  });

  test("an unreachable worker proves nothing", async () => {
    const { files } = remoteWorker(() => false);
    // The terminal cannot be listed: the worker is unavailable.
    const unavailable = runtimeWith({
      ok: false,
      error: { code: "runtime_unavailable" },
    });
    expect(await sessionExitProof(state, a, unavailable, execution)).toBe(
      "unreachable",
    );
    expect(files).not.toHaveBeenCalled();
    // The terminal looked gone, but the worker helper cannot be reached.
    files.mockRejectedValue(new worker.WorkerTransportUnavailable("down"));
    const runtime = runtimeWith(notFound);
    expect(await sessionExitProof(state, a, runtime, execution)).toBe(
      "unreachable",
    );
    expect(await transferredSessionExited(state, a, runtime, execution)).toBe(
      false,
    );
  });

  test("a live terminal, or a launch without a process registration, is not exited", async () => {
    remoteWorker(() => false);
    expect(
      await sessionExitProof(
        state,
        a,
        runtimeWith(
          { ok: true, value: { process: "alive", agent: "idle" } },
          { ok: true, value: "alive" },
        ),
        execution,
      ),
    ).toBe("terminal_alive");
    const legacy = {
      ...state,
      runs: [{ id: "R-1", assignment_id: a.id }],
    } as unknown as CommandState;
    expect(
      await sessionExitProof(legacy, a, runtimeWith(notFound), execution),
    ).toBe("unproven");
    // Without a remote proof the stop path keeps the old answer.
    expect(
      await stoppedSessionExited(runtimeWith(notFound), ref, {
        project_id: "fixture",
        assignment_id: a.id,
      }),
    ).toBe("unproven");
  });
});

describe("C-663 local session exit proof", () => {
  const localRef = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "local/t1",
    agent_name: "fixture",
    local_process_receipt: "receipt",
  } as RuntimeRef;
  const local = {
    ...a,
    machine_id: "local",
    runtime_ref: localRef,
  } as Assignment;
  const localState = {
    ...state,
    assignments: [local],
    runs: [],
  } as unknown as CommandState;

  test("a removed terminal row with the receipt's group gone is exited; a surviving group is not", async () => {
    let gone = true;
    const runtime = {
      ...runtimeWith(notFound),
      confirm_local_group_exit: vi.fn(async () => ({ ok: true, value: gone })),
      confirm_local_exit: vi.fn(async () => ({ ok: true, value: false })),
    } as unknown as Runtime;
    expect(await sessionExitProof(localState, local, runtime, undefined)).toBe(
      "exited",
    );
    gone = false;
    expect(await sessionExitProof(localState, local, runtime, undefined)).toBe(
      "unproven",
    );
    // The removed row alone is never enough.
    expect(
      await sessionExitProof(
        localState,
        {
          ...local,
          runtime_ref: { ...localRef, local_process_receipt: undefined },
        },
        runtimeWith(notFound),
        undefined,
      ),
    ).toBe("unproven");
  });
});
