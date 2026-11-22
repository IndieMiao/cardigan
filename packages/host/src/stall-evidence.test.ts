import type {
  Assignment,
  CommandState,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import * as worker from "@cardigan/runtime-herdr";
import { expect, test, vi } from "vitest";
import { stallEvidence } from "./stall-evidence.js";
import { stopSystemTurn } from "./stop-run.js";

const ref = {
  machine_id: "worker",
  runtime_machine: "agent",
  terminal_ref: "agent/t1",
  agent_name: "fixture",
  target: {
    project_id: "fixture",
    machine_id: "worker",
    session: "fixture",
    fingerprint: "a".repeat(64),
    generation: "initial",
  },
} as RuntimeRef;
const owner = {
  id: "A-1",
  scope: "standing",
  machine_id: ref.machine_id,
  runtime_ref: ref,
} as Assignment;
const state = {
  project_id: "fixture",
  assignments: [owner],
  runs: [],
  roles: [],
} as unknown as CommandState;
const execution = {
  mode: "agent-ssh",
  machine: "agent",
  target: ref.target,
} as ExecutionConfig;

test("remote stall diagnostics read only the configured project target, and an ownership observation never grants stop authority", async () => {
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { agent: "idle", process: "alive" },
    })),
    observe_retirement: vi.fn(async () => ({ ok: true, value: "alive" })),
    release: vi.fn(),
  };
  const inspect = (config: ExecutionConfig) =>
    stallEvidence(
      state,
      owner,
      runtime as unknown as Runtime,
      config,
      undefined,
      "R-1",
    );
  expect(await inspect(execution)).toMatchObject({
    workspace: "no_worktree",
    terminal_owner: "confirmed",
    can_restart: false,
  });
  expect(runtime.observe_retirement).toHaveBeenCalledTimes(1);
  expect(
    await inspect({
      ...execution,
      target: { ...ref.target!, fingerprint: "b".repeat(64) },
    }),
  ).toMatchObject({
    workspace: "unknown",
    terminal_owner: "unconfirmed",
    can_restart: false,
  });
  expect(runtime.observe_retirement).toHaveBeenCalledTimes(1);
  expect(runtime.release).not.toHaveBeenCalled();
});

test("a missing row after a started stop does not settle the old execution", async () => {
  const runtime = {
    observe_retirement: vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "runtime_not_found" },
      })
      .mockResolvedValueOnce({ ok: true, value: "exited" }),
    retire_idle: vi.fn(),
    release: vi.fn(),
  };
  const probe = () =>
    stopSystemTurn(
      runtime as unknown as Runtime,
      ref,
      { project_id: "fixture", assignment_id: "A-1" },
      true,
      vi.fn(),
      vi.fn(),
    );
  expect(await probe()).toBe("terminal_exit_unconfirmed");
  expect(await probe()).toBe("exited");
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expect(runtime.release).not.toHaveBeenCalled();
});

test("remote recovery needs both the bound generation's OS exit and its finished terminal, and never signals it", async () => {
  const generation = "b".repeat(32),
    generated = {
      ...ref,
      launch_generation: { generation, run_id: "R-1" as const },
    };
  const a = { ...owner, runtime_ref: generated };
  const identity = {
    machine: ref.target!.fingerprint,
    terminal: generation,
    uid: 1000,
    pid: 42,
    process_group: 42,
    start: "20",
    boot: "boot",
  };
  const launch = {
    generation,
    target: ref.target,
    process: identity,
    runtime_ref: generated,
  };
  const s = {
    ...state,
    assignments: [a],
    runs: [{ id: "R-1", assignment_id: a.id, launch_publication: launch }],
  } as unknown as CommandState;
  const reply = {
    version: 1 as const,
    phase: "running" as const,
    observed: "exited" as const,
    process: identity,
    project: state.project_id,
    assignment: a.id,
    run: "R-1",
    generation,
    target: identity.machine,
  };
  const status = vi.spyOn(worker, "workerFiles").mockResolvedValue(reply);
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { agent: "unknown", process: "exited" },
    })),
    observe_retirement: vi.fn(async () => ({ ok: true, value: "exited" })),
    retire_idle: vi.fn(),
    release: vi.fn(),
  } as unknown as Runtime;
  try {
    expect(
      await stallEvidence(s, a, runtime, execution, undefined, "R-1"),
    ).toMatchObject({ can_restart: true });
    status.mockResolvedValue({
      ...reply,
      process: { ...identity, start: "other" },
    });
    expect(
      await stallEvidence(s, a, runtime, execution, undefined, "R-1"),
    ).toMatchObject({ can_restart: false });
    status.mockResolvedValue({ ...reply, observed: "alive" });
    expect(
      await stallEvidence(s, a, runtime, execution, undefined, "R-1"),
    ).toMatchObject({ can_restart: false });
    expect(
      await stopSystemTurn(
        runtime,
        generated,
        { project_id: s.project_id, assignment_id: a.id },
        false,
        vi.fn(),
        vi.fn(),
      ),
    ).toBe("exited");
    expect(runtime.retire_idle).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
  } finally {
    status.mockRestore();
  }
});
