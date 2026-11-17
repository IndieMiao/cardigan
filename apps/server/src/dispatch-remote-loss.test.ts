import {
  assign,
  completeHumanAction,
  finishRun,
  queueRun,
} from "@cardigan/domain";
import { issueTokenInTransaction } from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
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
    lastSuccessfulBackup: () => backup,
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
