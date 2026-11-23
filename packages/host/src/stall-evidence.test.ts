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
  let groupAlive = false;
  const group = vi
    .spyOn(worker, "agentProcessCommand")
    .mockImplementation(async (config, argv) => {
      expect(config).toBe(execution);
      expect(argv.slice(-3)).toEqual(["42", "42", "1000"]);
      // Run the actual worker probe, substituting only the OS observations.
      const fixture = `import os, sys
calls = []
def query(pid, sig):
    assert sig == 0
    calls.append(pid)
    if pid == -42 and ${groupAlive ? "True" : "False"}: return
    raise ProcessLookupError()
os.kill = query
os.geteuid = lambda: 1000
${argv[3]}
assert calls == [42, -42]`;
      return {
        file: "python3",
        args: ["-IB", "-c", fixture, ...argv.slice(-3)],
      };
    });
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
    groupAlive = true;
    expect(
      await stallEvidence(s, a, runtime, execution, undefined, "R-1"),
    ).toMatchObject({ can_restart: false });
    groupAlive = false;
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
    group.mockRestore();
  }
});

test.each(["darwin", "linux-worker"] as const)(
  "C-626: with no hc activity the bound idle editor confirms a live system turn; only a macOS worker may be stopped (%s)",
  async (platform) => {
    const generated = {
      ...ref,
      launch_generation: { generation: "g1", run_id: "R-1" as const },
    };
    const a = { ...owner, runtime_ref: generated };
    const s = {
      ...state,
      assignments: [a],
      runs: [{ id: "R-1", assignment_id: a.id, harness: "claude-code" }],
    } as unknown as CommandState;
    const config = {
      ...execution,
      ...(platform === "darwin"
        ? {
            macosCore: { python: "/usr/bin/python3", retiredLaunchdLabel: "x" },
          }
        : {}),
    } as ExecutionConfig;
    let editor = true;
    const runtime = {
      status: vi.fn(async () => ({
        ok: true,
        value: { agent: "unknown", process: "alive", observed_seq: 1 },
      })),
      observe_retirement: vi.fn(async (_ref, identity) => ({
        ok: true,
        value: identity.idle_prompt && editor ? "alive" : "unknown",
      })),
      retire_idle: vi.fn(),
      release: vi.fn(),
    } as unknown as Runtime;
    const view = () => stallEvidence(s, a, runtime, config, undefined, "R-1");
    expect(await view()).toMatchObject({
      idle_basis: "bound_idle_prompt",
      terminal_owner: "confirmed",
      process_state: "alive",
      can_restart: platform === "darwin",
    });
    expect(
      vi.mocked(runtime.observe_retirement!).mock.calls.map(([, i]) => i),
    ).toEqual([
      expect.not.objectContaining({ idle_prompt: expect.anything() }),
      expect.objectContaining({
        system_finished_turn: true,
        idle_prompt: {
          project_id: s.project_id,
          assignment_id: a.id,
          harness: "claude-code",
        },
      }),
    ]);
    // Not an idle editor (a running turn, a prompt or a draft): unconfirmed.
    editor = false;
    expect(await view()).toMatchObject({
      idle_basis: null,
      terminal_owner: "unconfirmed",
      can_restart: false,
    });
    // A harness without a recognizable editor never gets the substitute.
    editor = true;
    vi.mocked(runtime.observe_retirement!).mockClear();
    expect(
      await stallEvidence(
        {
          ...s,
          runs: [{ id: "R-1", assignment_id: a.id, harness: "pi" }],
        } as unknown as CommandState,
        a,
        runtime,
        config,
        undefined,
        "R-1",
      ),
    ).toMatchObject({ terminal_owner: "unconfirmed", can_restart: false });
    expect(runtime.observe_retirement).toHaveBeenCalledOnce();
    expect(runtime.retire_idle).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
  },
);

test("C-626: a macOS worker turn stop passes the prompt binding and settles only on the registered group's exit", async () => {
  const generated = {
    ...ref,
    launch_generation: { generation: "g1", run_id: "R-1" as const },
  };
  let exited = false;
  const stop = { path: "darwin_pid", signal: "TERM", pid: 42 } as const;
  const runtime = {
    observe_retirement: vi.fn(async () => ({
      ok: true,
      value: exited ? "exited" : "alive",
    })),
    retire_idle: vi.fn(async (_ref, options) => {
      expect(options).toMatchObject({
        system_finished_turn: true,
        idle_prompt: { harness: "codex" },
      });
      expect(await options.workspace_preflight()).toBe(true);
      expect(options.before_signal()).toBe(true);
      exited = true;
      return { ok: true, value: { outcome: "exited", stop } };
    }),
    release: vi.fn(),
  } as unknown as Runtime;
  const report = vi.fn();
  let groupGone = false;
  const run = (alreadyStopping = false) =>
    stopSystemTurn(
      runtime,
      generated,
      { project_id: "fixture", assignment_id: "A-1" },
      alreadyStopping,
      async () => true,
      () => true,
      async () => groupGone,
      {
        idlePrompt: {
          project_id: "fixture",
          assignment_id: "A-1",
          harness: "codex",
        },
        remoteSignal: true,
        report,
      },
    );
  // The terminal finished but the registered group is still alive: not settled.
  expect(await run()).toBe("terminal_exit_unconfirmed");
  expect(report).toHaveBeenCalledWith(stop);
  expect(runtime.retire_idle).toHaveBeenCalledOnce();
  // A later observation of the started stop never signals again.
  groupGone = true;
  expect(await run(true)).toBe("exited");
  expect(runtime.retire_idle).toHaveBeenCalledOnce();
  expect(runtime.release).not.toHaveBeenCalled();
});
