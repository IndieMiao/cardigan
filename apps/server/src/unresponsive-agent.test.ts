import type { Assignment, Run, Runtime } from "@cardigan/domain";
import {
  dispatchRun,
  hostOpsPending,
  postComment,
  queueRun,
} from "@cardigan/domain";
import * as host from "@cardigan/host";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { setup as stalls } from "../test-support/dispatch-stalls.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// C-730 (sensen A-210/A-234/A-289, mac-mini): the Agent CLI exited, its
// terminal stayed live with only the wrapper left. Every idle retirement was
// withdrawn with probe_invalid (the idle owner no longer serves its CLI), the
// C-672 proof never fired, and new work waited in awaiting_dispatch until a
// human ran `cardigan assignment stop`. Host Ops could not help: its restart
// and cancel only accepted local Assignments.

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

function setup(machine: "worker" | "local") {
  const f =
    machine === "local"
      ? dispatchFixture()
      : dispatchFixture("worker", "none", "darwin");
  fixtures.push(f);
  const target = f.create();
  f.session(target.assignment);
  const owner = () =>
    f.state().assignments.find((a) => a.id === target.assignment.id)!;
  const patch = (value: Partial<Assignment>) => {
    const current = owner();
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, { ...current, ...value } as Assignment),
    );
  };
  // The last sign of life of the Agent: its finished Run and MCP call.
  patch({
    last_mcp_activity_at: f.clock.now(),
    ...(machine === "local"
      ? {
          runtime_ref: {
            ...owner().runtime_ref!,
            local_process_receipt: "fixture-receipt",
          },
        }
      : {}),
  });
  const skip = () => {
    for (const card of [undefined, ...f.state().cards.map((c) => c.id)])
      f.store.advanceRouterCursor(
        f.project,
        card ?? PROJECT_EVENT_STREAM,
        f.store.getUpdates({
          project_id: f.project,
          ...(card ? { card_id: card } : {}),
        }).latest_seq,
      );
  };
  skip();
  let agentAlive = false;
  let closed = false;
  // The worker launch journal: the registered CLI's birth identity is gone,
  // still there, or the read failed (timeout, ssh error, mismatch).
  let journal: "exited" | "alive" | "unreadable" = "exited";
  const result = <T>(value: T) => ({ ok: true as const, value });
  const runtime: DispatcherOptions["runtime"] = {
    // The terminal stays live: hc only sees the wrapper program.
    status: vi.fn(async () =>
      closed
        ? {
            ok: false as const,
            error: { code: "runtime_not_found" as const, message: "gone" },
          }
        : result({
            process: "alive" as const,
            agent: "unknown" as const,
            observed_seq: 1,
          }),
    ),
    // The strict C-672 proof is not available on this worker.
    observe_agent_exit: vi.fn(async () => result(false)),
    observe_retirement: vi.fn(async () =>
      result(agentAlive && !closed ? ("alive" as const) : ("unknown" as const)),
    ),
    confirm_local_group_exit: vi.fn(async () => result(!agentAlive || closed)),
    confirm_local_exit: vi.fn(async () => result(closed)),
    retire_idle: vi.fn<NonNullable<Runtime["retire_idle"]>>(async () =>
      result({
        outcome: "withdrawn" as const,
        evidence: { stage: "probe" as const, reason: "probe_invalid" as const },
      }),
    ),
    release: vi.fn(async () => {
      closed = true;
      return result(undefined);
    }),
    wake: vi.fn(async () => result({ sent: true })),
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const startRun = vi.fn(
    async ({
      run,
      assignment,
    }: Parameters<NonNullable<DispatcherOptions["startRun"]>>[0]) => {
      closed = false;
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
    },
  );
  const dispatcher = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime,
    startRun,
    snapshot: vi.fn(async () => ({
      model: "fixture",
      agent_cli_version: "1",
      launch_profile_ref: "current-profile",
      harness: "claude-code" as const,
      effort: "high",
    })),
  });
  const comment = () =>
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Read updates",
        },
        p,
      ),
    );
  // Remote: the substituted worker evidence (the real one is covered in
  // packages/host unresponsive-proof.test.ts). Local: the kernel receipt checks.
  const proof: host.UnresponsiveProof =
    machine === "local"
      ? host.workerProof
      : {
          agent: async (rt, _state, a, ref) => {
            const seen = await rt.observe_retirement!(ref, {
              project_id: f.project,
              assignment_id: a.id,
            });
            if (!seen.ok) return "unknown";
            if (seen.value === "alive" || journal === "alive") return "alive";
            return journal === "exited" ? "gone" : "unknown";
          },
          sessionGone: async () => closed && journal === "exited",
        };
  const replaced = () =>
    f
      .state()
      .events.filter((e) => e.type === "session_replaced")
      .map((e) => e.payload);
  /** One maintenance pass a minute; returns the minutes until a release. */
  const maintain = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      await host.upgradeIdleAssignmentRoles(
        f.store,
        f.project,
        runtime,
        f.clock,
        proof,
      );
      if (replaced().length) return i;
      f.advance(60_000);
    }
    return undefined;
  };
  return {
    ...f,
    target,
    owner,
    runtime,
    dispatcher,
    startRun,
    comment,
    replaced,
    maintain,
    unreadable: () => {
      journal = "unreadable";
    },
    agentAlive: () => {
      journal = "alive";
      agentAlive = true;
    },
  };
}

test.each(["worker", "local"] as const)(
  "%s: after three probe_invalid withdrawals the terminal is closed, the session settled and new work starts a new session",
  async (machine) => {
    const f = setup(machine);
    const old = f.owner().runtime_ref;
    f.advance(61 * 60_000);
    const minutes = await f.maintain(15);
    expect(minutes).toBeDefined();
    expect(minutes).toBeLessThanOrEqual(6);
    expect(f.runtime.retire_idle).toHaveBeenCalledTimes(3);
    expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(old, {
      force: true,
    });
    expect(f.replaced()).toMatchObject([
      {
        reason: "agent_unresponsive",
        trigger: "probe_invalid",
        probe_invalid: 3,
        old_runtime_ref: old,
      },
    ]);
    expect(f.owner()).toMatchObject({ runtime_ref: null });
    expect(f.owner().idle_retirement).toBeUndefined();
    // The card timeline says what happened.
    expect(
      f.store.uow
        .read((tx) => tx.timeline.list(f.project, f.target.card.id))
        .map((t) => t.body),
    ).toContainEqual(expect.stringContaining("连续 3 次未取得有效进程身份"));
    // New work starts a fresh session; nothing is typed into the old one.
    f.comment();
    await f.dispatcher.tick([f.project]);
    expect(f.startRun).toHaveBeenCalledOnce();
    expect(f.runtime.wake).not.toHaveBeenCalled();
  },
);

test.each(["worker", "local"] as const)(
  "%s: a live Agent CLI keeps its session however often retirement is withdrawn",
  async (machine) => {
    const f = setup(machine);
    f.agentAlive();
    const old = f.owner().runtime_ref;
    f.advance(61 * 60_000);
    expect(await f.maintain(20)).toBeUndefined();
    expect(
      (f.runtime.retire_idle as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.replaced()).toEqual([]);
    expect(f.owner().runtime_ref).toEqual(old);
  },
);

test("a failed or timed-out worker read is never taken as an exit, and the probes back off", async () => {
  // V-3320: e.g. Godot import load on mac-mini: ps and the worker helper
  // time out while the CLI is alive with uncommitted changes.
  const f = setup("worker");
  f.unreadable();
  const old = f.owner().runtime_ref;
  f.advance(61 * 60_000);
  expect(await f.maintain(40)).toBeUndefined();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.replaced()).toEqual([]);
  expect(f.owner().runtime_ref).toEqual(old);
  // Refused at 3 withdrawals, then again after 5, 10 and 20 minutes.
  expect(
    (f.runtime.observe_retirement as ReturnType<typeof vi.fn>).mock.calls
      .length,
  ).toBeLessThanOrEqual(4);
});

test("an MCP call after the withdrawals is a sign of life and restarts the count", async () => {
  const f = setup("worker");
  f.advance(61 * 60_000);
  // Two withdrawals (retry after 1 and 2 minutes), then the Agent answers.
  await f.maintain(2);
  const current = f.owner();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...current,
      last_mcp_activity_at: f.clock.now(),
    }),
  );
  f.advance(60_000);
  await f.maintain(3);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.replaced()).toEqual([]);
});

// Host Ops: restart and cancel on a remote managed Assignment.

function remote(cliAlive = false, journal: "exited" | "unreadable" = "exited") {
  const f = stalls("worker", {
    // The substituted worker evidence (see unresponsive-proof.test.ts).
    unresponsiveProof: {
      agent: async (rt, _state, a, ref) => {
        const seen = await rt.observe_retirement!(ref, {
          project_id: f.project,
          assignment_id: a.id,
        });
        if (!seen.ok) return "unknown";
        if (seen.value === "alive") return "alive";
        return journal === "exited" ? "gone" : "unknown";
      },
      sessionGone: async (rt, _state, _a, ref) => {
        const seen = await rt.status(ref);
        return seen.ok && seen.value.process === "exited";
      },
    },
  });
  f.runtime.observe_retirement = vi.fn(async (ref) => {
    const seen = await f.runtime.status(ref);
    return {
      ok: true as const,
      value:
        seen.ok && seen.value.process === "exited"
          ? ("exited" as const)
          : cliAlive
            ? ("alive" as const)
            : ("unknown" as const),
    };
  });
  const owner = () =>
    f.state().assignments.find((a) => a.id === f.target.assignment.id)!;
  const execute = (
    tool: "host_ops_restart_assignment" | "host_ops_cancel_run",
    target_id: string,
    reason = "Agent 进程已退出，终端残留",
  ) =>
    f.service.tools.execute(f.context, tool, {
      target_id,
      reason,
      idempotency_key: `${tool}:${target_id}:${reason}`,
    });
  return { ...f, owner, execute };
}

test("Host Ops restart of a remote Assignment whose Agent is gone closes the terminal and new work resumes", async () => {
  const f = remote();
  const old = f.owner().runtime_ref;
  const result = await f.execute("host_ops_restart_assignment", f.owner().id);
  expect(result).toMatchObject({
    assignment_id: f.owner().id,
    result: "session_released",
  });
  expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(old, {
    force: true,
  });
  expect(f.owner()).toMatchObject({ runtime_ref: null });
  expect(
    f
      .state()
      .events.filter((e) => e.type === "session_replaced")
      .map((e) => e.payload),
  ).toMatchObject([
    {
      reason: "agent_unresponsive",
      trigger: "host_ops",
      requested_by: f.ops.id,
      tool: "host_ops_restart_assignment",
      old_runtime_ref: old,
    },
  ]);
  // Idempotent: the same request returns the same result, nothing more.
  expect(await f.execute("host_ops_restart_assignment", f.owner().id)).toEqual(
    result,
  );
  expect(f.runtime.release).toHaveBeenCalledOnce();
  f.comment();
  await new Dispatcher(f.options).tick([f.project]);
  expect(f.options.startRun).toHaveBeenCalledOnce();
});

function queue(f: ReturnType<typeof remote>) {
  const id = f.owner().id;
  return f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  ) as Run;
}

test("Host Ops cancel of a dispatched remote Run releases the stale session and cancels that Run", async () => {
  const f = remote();
  const run = queue(f);
  const ref = f.owner().runtime_ref!;
  f.apply((s, a, p) =>
    dispatchRun(s, a, { run_id: run.id, runtime_ref: ref }, p),
  );
  const result = await f.execute("host_ops_cancel_run", run.id);
  expect(result).toMatchObject({
    assignment_id: f.owner().id,
    run_id: run.id,
    result: "session_released",
  });
  expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
  });
  expect(f.owner()).toMatchObject({ runtime_ref: null });
});

test("C-759: Host Ops cancels a queued, never-started Run directly and leaves the live session alone", async () => {
  // The previous turn's session is still live (its Agent even answers alive).
  const f = remote(true);
  const old = f.owner().runtime_ref;
  const run = queue(f);
  const result = await f.execute("host_ops_cancel_run", run.id);
  expect(result).toMatchObject({
    assignment_id: f.owner().id,
    run_id: run.id,
    result: "queued_run_cancelled",
  });
  expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
  });
  // No terminal was touched; the session and its credentials stay.
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(old);
  const audit = f
    .state()
    .events.filter((e) => e.type === "host_ops_action_taken");
  expect(audit.map((e) => e.payload)).toMatchObject([
    {
      tool: "host_ops_cancel_run",
      target_id: run.id,
      result: "queued_run_cancelled",
    },
  ]);
  // An audit record, never a pending execution that would fence the session.
  expect(hostOpsPending(f.state().events, f.owner().id)).toBe(false);
  // Idempotent replay.
  expect(await f.execute("host_ops_cancel_run", run.id)).toEqual(result);
});

test("C-759: a dispatched remote Run whose Agent is alive stays protected (agent_alive)", async () => {
  const f = remote(true);
  const old = f.owner().runtime_ref!;
  const run = queue(f);
  f.apply((s, a, p) =>
    dispatchRun(s, a, { run_id: run.id, runtime_ref: old }, p),
  );
  await expect(f.execute("host_ops_cancel_run", run.id)).rejects.toMatchObject({
    code: "illegal_transition",
    message: expect.stringContaining("worker 显示 Agent 进程仍在运行"),
  });
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(old);
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
    "dispatched",
  );
});

test("Host Ops never closes the terminal of a remote Agent that is still running", async () => {
  const f = remote(true);
  const old = f.owner().runtime_ref;
  await expect(
    f.execute("host_ops_restart_assignment", f.owner().id),
  ).rejects.toMatchObject({
    message: expect.stringContaining("worker 显示 Agent 进程仍在运行"),
  });
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(old);
});

test("Host Ops does not close a remote terminal on an unreadable worker journal or without a reason", async () => {
  const f = remote(false, "unreadable");
  const old = f.owner().runtime_ref;
  await expect(
    f.execute("host_ops_restart_assignment", f.owner().id),
  ).rejects.toMatchObject({
    message: expect.stringContaining("无法从 worker 确认 Agent 进程状态"),
  });
  const g = remote();
  await expect(
    g.execute("host_ops_restart_assignment", g.owner().id, " "),
  ).rejects.toBeDefined();
  for (const x of [f, g]) expect(x.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(old);
});

// C-759: the previous turn ended, the CLI reports `done` and its session
// stays live while a queued Run waits (sensen A-461, cardigan-ci).
function idle(agent: "done" | "working" | "unknown" = "done") {
  const f = remote(true);
  const original = vi.mocked(f.runtime.status).getMockImplementation()!;
  let state: "done" | "working" | "unknown" = agent;
  vi.mocked(f.runtime.status).mockImplementation(async (ref) => {
    const seen = await original(ref);
    return seen.ok && seen.value.process === "alive"
      ? { ok: true, value: { ...seen.value, agent: state } }
      : seen;
  });
  const stop = (reason = "空闲会话挡着排队 Run") =>
    f.service.tools.execute(f.context, "host_ops_stop_assignment", {
      target_id: f.owner().id,
      reason,
      idempotency_key: `stop:${f.owner().id}:${reason}`,
    });
  return {
    ...f,
    stop,
    set agent(value: "done" | "working" | "unknown") {
      state = value;
    },
  };
}

test("C-759: Host Ops stops an idle session of an ended turn like assignment stop; the queued Run starts in a new session", async () => {
  const f = idle();
  const old = f.owner().runtime_ref;
  const run = queue(f);
  const result = await f.stop();
  expect(result).toMatchObject({
    assignment_id: f.owner().id,
    result: "session_stopped",
    basis: "agent_done",
  });
  expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(old, {
    force: true,
  });
  expect(f.owner()).toMatchObject({ runtime_ref: null });
  // No Run was queued or cancelled; the waiting one is kept.
  expect(
    f
      .state()
      .runs.filter(
        (r) => r.assignment_id === f.owner().id && r.status === "queued",
      )
      .map((r) => r.id),
  ).toEqual([run.id]);
  expect(
    f
      .state()
      .events.filter((e) => e.type === "session_replaced")
      .map((e) => e.payload),
  ).toMatchObject([
    {
      reason: "idle_session_stopped",
      trigger: "host_ops",
      tool: "host_ops_stop_assignment",
      requested_by: f.ops.id,
      cancelled_run_ids: [],
      old_runtime_ref: old,
    },
  ]);
  // Idempotent replay, no second close.
  expect(await f.stop()).toEqual(result);
  expect(f.runtime.release).toHaveBeenCalledOnce();
  f.comment();
  await new Dispatcher(f.options).tick([f.project]);
  expect(f.options.startRun).toHaveBeenCalledOnce();
});

test("C-759: Host Ops stop is refused while the Agent works or a Run of the session is unfinished", async () => {
  const f = idle("working");
  const old = f.owner().runtime_ref!;
  queue(f);
  await expect(f.stop()).rejects.toMatchObject({
    code: "illegal_transition",
    message: expect.stringContaining("Agent 不是空闲状态"),
  });
  f.agent = "done";
  const g = idle();
  const run = queue(g);
  const ref = g.owner().runtime_ref!;
  g.apply((s, a, p) =>
    dispatchRun(s, a, { run_id: run.id, runtime_ref: ref }, p),
  );
  await expect(g.stop()).rejects.toMatchObject({
    message: expect.stringContaining("上一轮没有结束"),
  });
  for (const x of [f, g]) expect(x.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(old);
  await expect(f.stop(" ")).rejects.toBeDefined();
});

/** C-838: a Claude Code session: hc never has its activity (`unknown`). */
function claudeIdle(editor: () => boolean) {
  const f = idle("unknown");
  const ended = queue(f);
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...ended,
      status: "completed",
      outcome: "completed",
      summary: "fixture",
      harness: "claude-code",
      started_at: f.clock.now(),
      finished_at: f.clock.now(),
    } as Run),
  );
  const observe_prompt = vi.fn<NonNullable<Runtime["observe_prompt"]>>(
    async () => ({ ok: true, value: editor() }),
  );
  f.runtime.observe_prompt = observe_prompt;
  // Keep the `agent` setter.
  return Object.assign(f, { observe_prompt });
}

test("C-838: Host Ops stops an ended Claude Code turn with no reported activity on its bound empty editor", async () => {
  const f = claudeIdle(() => true);
  const old = f.owner().runtime_ref!;
  const run = queue(f);
  expect(await f.stop()).toMatchObject({
    assignment_id: f.owner().id,
    result: "session_stopped",
    basis: "bound_idle_prompt",
  });
  // Read before deciding and again right before closing.
  expect(f.observe_prompt).toHaveBeenCalledTimes(2);
  expect(f.observe_prompt).toHaveBeenCalledWith(old, {
    project_id: f.project,
    assignment_id: f.owner().id,
    harness: "claude-code",
  });
  expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(old, {
    force: true,
  });
  expect(f.owner()).toMatchObject({ runtime_ref: null });
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("queued");
});

test("C-838: without the editor, Host Ops stop of an unknown session is refused with next steps, not the host CLI", async () => {
  const f = claudeIdle(() => false);
  queue(f);
  const refusal = await f.stop().then(
    () => undefined,
    (e: { code: string; message: string }) => e,
  );
  expect(refusal).toMatchObject({ code: "illegal_transition" });
  const message = refusal?.message ?? "";
  expect(message).toContain("读不到 Agent 的活动状态（unknown）");
  expect(message).toContain("下一步");
  expect(message).toContain("host_ops_read_diagnostics");
  expect(message).toContain("停滞巡检");
  expect(message).toContain("请 PM 在卡上点名该指派");
  expect(message).not.toContain("cardigan assignment stop");
  expect(f.runtime.release).not.toHaveBeenCalled();
  // Shown when deciding, gone right before closing: still refused.
  let calls = 0;
  const g = claudeIdle(() => ++calls === 1);
  queue(g);
  await expect(g.stop()).rejects.toMatchObject({
    code: "illegal_transition",
  });
  expect(calls).toBe(2);
  expect(g.runtime.release).not.toHaveBeenCalled();
  expect(g.owner().runtime_ref).not.toBeNull();
});

test("C-838: the editor never stops a session with a Run in flight or a reported turn", async () => {
  const f = claudeIdle(() => true);
  const run = queue(f);
  const ref = f.owner().runtime_ref!;
  f.apply((s, a, p) =>
    dispatchRun(s, a, { run_id: run.id, runtime_ref: ref }, p),
  );
  await expect(f.stop()).rejects.toMatchObject({
    message: expect.stringContaining("上一轮没有结束"),
  });
  const g = claudeIdle(() => true);
  queue(g);
  g.agent = "working";
  await expect(g.stop()).rejects.toMatchObject({
    message: expect.stringContaining("Agent 不是空闲状态（working）"),
  });
  expect(g.observe_prompt).not.toHaveBeenCalled();
  for (const x of [f, g]) expect(x.runtime.release).not.toHaveBeenCalled();
});
