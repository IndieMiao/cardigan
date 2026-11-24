import type { Assignment, Run, Runtime } from "@cardigan/domain";
import { dispatchRun, postComment, queueRun } from "@cardigan/domain";
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
    agentAlive: () => {
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

function remote(cliAlive = false) {
  const f = stalls("worker");
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
  ) =>
    f.service.tools.execute(f.context, tool, {
      target_id,
      reason: "Agent 进程已退出，终端残留",
      idempotency_key: `${tool}:${target_id}`,
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

test("Host Ops cancel of a remote Run releases the stale session and cancels that Run", async () => {
  const f = remote();
  const id = f.owner().id;
  const run = f.apply((s, a, p) =>
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
