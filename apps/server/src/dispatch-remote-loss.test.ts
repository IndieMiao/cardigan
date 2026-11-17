import { setImmediate } from "node:timers/promises";
import {
  assign,
  completeHumanAction,
  finishRun,
  hostOpsPending,
  queueRun,
} from "@cardigan/domain";
import { issueTokenInTransaction } from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { startControlPlane } from "./assembly.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

let f: ReturnType<typeof dispatchFixture>;
let target: ReturnType<typeof f.create>;
let events: ReturnType<typeof runtimeEvents>;
let monitor: RuntimeMonitor;
let token: ReturnType<typeof issueTokenInTransaction>;
const backup = {
  sha: "b".repeat(40),
  at: "2029-12-31T23:59:00.000Z",
  branch: "agent/C-1/W-1",
};
const owner = () =>
  f.state().assignments.find((a) => a.id === target.assignment.id);
const currentRun = () =>
  f.state().runs.find((r) => r.assignment_id === target.assignment.id);
const startMonitor = () =>
  new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
  });
beforeEach(() => {
  f = dispatchFixture();
  f.store.uow.run((tx) =>
    tx.machines.put(f.project, {
      id: "worker-a",
      label: "Worker",
      herdr_machine: "worker-a",
      os: "linux",
      arch: "x64",
      tags: [],
      max_assignments: 1,
      status: "online",
      last_seen: f.clock.now(),
    }),
  );
  target = f.create("worker-a");
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...target.assignment,
      branch: backup.branch,
    }),
  );
  f.session(target.assignment, false);
  token = f.store.uow.run((tx) =>
    issueTokenInTransaction(tx, f.project, target.assignment.id, {
      role_version: 1,
      allowed_tools: ["finish_run"],
    }),
  );
  f.store.uow.run((tx) =>
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project, undefined),
      type: "assignment_branch_backed_up",
      actor: { kind: "system", project_id: f.project },
      payload: {
        assignment_id: target.assignment.id,
        machine_id: "worker-a",
        branch: backup.branch,
        sha: backup.sha,
        ref: `refs/cardigan/backups/worker-a/${backup.branch}`,
      },
      created_at: backup.at,
    }),
  );
  events = runtimeEvents();
  monitor = startMonitor();
  monitor.reconcile();
});
afterEach(async () => {
  await monitor.stop();
  f.close();
});
async function lose() {
  events.send({
    seq: 1,
    type: "lost",
    terminal_ref: f.refFor(target.assignment).terminal_ref,
  });
  await expect.poll(() => owner()?.runtime_state).toBe("unknown");
  f.advance(300000);
  monitor.reconcile();
  expect(owner()?.runtime_state).toBe("lost");
}
function alive(seq: number) {
  events.send({
    seq,
    type: "snapshot",
    observations: [
      {
        terminal_ref: f.refFor(target.assignment).terminal_ref,
        status: { process: "alive", agent: "idle", observed_seq: seq },
      },
    ],
  });
}

test.each([
  "unknown",
  "lost",
  "terminal.lost",
  "removed",
  "snapshot",
  "missed",
  "runtime_not_found",
] as const)(
  "%s after release keeps observing the old worker and fences its replacement when alive returns",
  async (observation) => {
    await lose();
    const action = f.state().human_actions[0];
    if (!action) throw new Error("Missing exit request");
    f.apply((s, a, p) =>
      completeHumanAction(
        s,
        a,
        {
          human_action_id: action.id,
          text: "Old process stopped",
        },
        p,
      ),
    );
    monitor.reconcile();
    expect(owner()?.status).toBe("released");
    const replacement = f.apply((s, a, p) =>
      assign(
        s,
        a,
        {
          work_item_id: target.item.id,
          role_id: "coder",
          machine_id: "local",
          recovery_source: "main",
        },
        p,
      ),
    );
    if (observation === "runtime_not_found") {
      const session = events.sessions.at(-1);
      if (!session) throw new Error("Missing old worker subscription");
      session.push({
        ok: false,
        error: { code: "runtime_not_found", message: "Terminal not found" },
      });
    } else {
      events.send({
        seq: 2,
        type: observation === "unknown" ? "snapshot" : observation,
        terminal_ref: f.refFor(target.assignment).terminal_ref,
        observations:
          observation === "unknown"
            ? [
                {
                  terminal_ref: f.refFor(target.assignment).terminal_ref,
                  status: {
                    process: "unknown",
                    agent: "unknown",
                    observed_seq: 2,
                  },
                },
              ]
            : [],
      });
    }
    await setImmediate();
    expect
      .soft(
        f.state().events.some((e) => e.type === "remote_worker_exit_observed"),
      )
      .toBe(false);
    monitor.reconcile();
    expect.soft(events.sessions.at(-1)?.signal?.aborted).toBe(false);
    alive(3);
    await setImmediate();
    expect(
      f.state().human_actions.filter((h) => h.status === "open"),
    ).toHaveLength(1);
    expect(hostOpsPending(f.state().events, replacement.id)).toBe(true);
    expect(() =>
      f.apply((s, a, p) =>
        queueRun(
          s,
          a,
          {
            assignment_id: replacement.id,
            model: "fixture",
            agent_cli_version: "fixture",
          },
          p,
        ),
      ),
    ).toThrow();
  },
);

test.each(["exited", "finished", "terminal.finished"] as const)(
  "%s after release records a definite exit and stops observing",
  async (observation) => {
    await lose();
    const action = f.state().human_actions[0];
    if (!action) throw new Error("Missing exit request");
    f.apply((s, a, p) =>
      completeHumanAction(
        s,
        a,
        { human_action_id: action.id, text: "Stopped" },
        p,
      ),
    );
    monitor.reconcile();
    events.send({
      seq: 2,
      type: observation === "exited" ? "snapshot" : observation,
      terminal_ref: f.refFor(target.assignment).terminal_ref,
      observations:
        observation === "exited"
          ? [
              {
                terminal_ref: f.refFor(target.assignment).terminal_ref,
                status: { process: "exited", agent: "done", observed_seq: 2 },
              },
            ]
          : [],
    });
    await setImmediate();
    expect(
      f.state().events.filter((e) => e.type === "remote_worker_exit_observed"),
    ).toHaveLength(1);
    monitor.reconcile();
    expect(events.sessions.at(-1)?.signal?.aborted).toBe(true);
  },
);

test("remote lost persists one confirmation, fences dispatch and atomically revokes every token on human settlement", async () => {
  await lose();
  const action = f.state().human_actions[0];
  if (!action) throw new Error("Missing exit request");
  expect(action.instructions).toContain(backup.sha);
  expect(action.instructions).toContain(backup.at);
  expect(f.store.verifyToken(token.token)).toBeDefined();
  const run = currentRun();
  if (!run) throw new Error("Missing Run");
  expect(() =>
    f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: target.assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
    ),
  ).toThrow();
  expect(() =>
    f.apply((s, a, p) =>
      assign(
        s,
        a,
        {
          work_item_id: target.item.id,
          role_id: "coder",
          machine_id: "local",
          recovery_source: "main",
        },
        p,
      ),
    ),
  ).toThrow();
  // Restart the monitor: the durable request and fence survive, no duplicate task.
  await monitor.stop();
  events = runtimeEvents();
  monitor = startMonitor();
  monitor.reconcile();
  expect(f.state().human_actions).toHaveLength(1);
  f.apply((s, a, p) =>
    completeHumanAction(
      s,
      a,
      { human_action_id: action.id, text: "Machine powered off" },
      p,
    ),
  );
  monitor.reconcile();
  expect(owner()).toMatchObject({
    status: "released",
    runtime_state: "released",
    runtime_ref: null,
  });
  expect(f.store.verifyToken(token.token)).toBeUndefined();
  expect(currentRun()).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(currentRun()?.pending_finish).toBeUndefined();
  expect(() =>
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "completed", summary: "late" },
          p,
        ),
      f.actorFor(target.assignment),
    ),
  ).toThrow();
  const next = f.apply((s, a, p) =>
    assign(
      s,
      a,
      {
        work_item_id: target.item.id,
        role_id: "coder",
        machine_id: "local",
        recovery_source: "backup",
      },
      p,
    ),
  );
  expect(next.recovery?.backup).toEqual(backup);
  expect(next.machine_id).toBe("local");
  expect(f.state().runs).toHaveLength(1);
});

test("a reconnecting old process stays lost and asks the human again if observed alive after confirmation", async () => {
  await lose();
  monitor.reconcile();
  alive(2);
  await expect
    .poll(
      () =>
        f.state().events.filter((e) => e.type === "remote_worker_alive").length,
    )
    .toBe(1);
  expect(owner()?.runtime_state).toBe("lost");
  expect(currentRun()?.status).toBe("unknown");
  const action = f.state().human_actions[0];
  if (!action) throw new Error("Missing exit request");
  f.apply((s, a, p) =>
    completeHumanAction(
      s,
      a,
      { human_action_id: action.id, text: "Stopped" },
      p,
    ),
  );
  monitor.reconcile();
  alive(3);
  await expect
    .poll(
      () => f.state().human_actions.filter((h) => h.status === "open").length,
    )
    .toBe(1);
  expect(owner()?.status).toBe("released");
  expect(currentRun()?.outcome).toBe("failed");
  expect(f.state().runs).toHaveLength(1);
});

test("the production control plane reads RW-1 backup records when it finds a persisted lost worker", async () => {
  await monitor.stop();
  const old = owner();
  const run = currentRun();
  if (!old || !run) throw new Error("Missing remote worker");
  f.store.uow.run((tx) => {
    tx.assignments.put(f.project, { ...old, runtime_state: "lost" });
    tx.runs.put(f.project, { ...run, status: "unknown" });
  });
  const runtime = {
    ...events.source,
    status: vi.fn(),
    wake: vi.fn(),
    provision: vi.fn(),
    release: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const startRun = vi.fn(),
    onError = vi.fn();
  const plane = startControlPlane({
    store: f.store,
    runtime,
    startRun,
    onError,
    clock: f.clock,
    intervalMs: 5,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
  });
  try {
    await expect.poll(() => f.state().human_actions.length).toBe(1);
    const instructions = f.state().human_actions[0]?.instructions;
    expect(instructions).toContain(backup.sha);
    expect(instructions).toContain(backup.at);
    expect(instructions).toContain(target.assignment.id);
    expect(instructions).toContain("worker-a");
    await expect
      .poll(() =>
        f.store
          .listNotifications({ project_id: f.project })
          .some((n) => n.kind === "needs_you"),
      )
      .toBe(true);
    expect(startRun).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await plane.stop();
  }
});
