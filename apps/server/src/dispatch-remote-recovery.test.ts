// Regression scenarios from the V-1991 independent review.
import { setImmediate } from "node:timers/promises";
import {
  type Assignment,
  assign,
  completeHumanAction,
  hostOpsPending,
  queueRun,
} from "@cardigan/domain";
import { issueTokenInTransaction } from "@cardigan/host";
import { expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

function setup() {
  const f = dispatchFixture();
  for (const machine of ["worker-a", "worker-b"])
    f.store.uow.run((tx) =>
      tx.machines.put(f.project, {
        id: machine,
        label: machine,
        herdr_machine: machine,
        os: "linux",
        arch: "x64",
        tags: [],
        max_assignments: 4,
        status: "online",
        last_seen: f.clock.now(),
      }),
    );
  const target = f.create("worker-a");
  f.session(target.assignment, false);
  const events = runtimeEvents();
  const monitor = new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
  });
  monitor.reconcile();
  const owner = (a: Assignment) => {
    const persisted = f.state().assignments.find((v) => v.id === a.id);
    if (!persisted) throw new Error("Missing Assignment");
    return persisted;
  };
  const subscription = (a: Assignment) =>
    events.sessions.findLastIndex(
      (s) =>
        s.ref.terminal_ref === f.refFor(a).terminal_ref && !s.signal?.aborted,
    );
  const send = (a: Assignment, seq: number, type: string, generation = 1) => {
    events.send(
      {
        seq,
        type,
        source_generation: generation,
        terminal_ref: f.refFor(a).terminal_ref,
      },
      subscription(a),
    );
  };
  async function lose(a: Assignment) {
    send(a, 1, "lost");
    await expect.poll(() => owner(a).runtime_state).toBe("unknown");
    f.advance(300000);
    monitor.reconcile();
    expect(owner(a).runtime_state).toBe("lost");
  }
  function confirm() {
    const action = f.state().human_actions.findLast((h) => h.status === "open");
    if (!action) throw new Error("Missing open exit request");
    f.apply((s, a, p) =>
      completeHumanAction(
        s,
        a,
        { human_action_id: action.id, text: "Fixture human confirms exit" },
        p,
      ),
    );
  }
  function recover(machine: string) {
    return f.apply((s, a, p) =>
      assign(
        s,
        a,
        {
          work_item_id: target.item.id,
          role_id: "coder",
          machine_id: machine,
          recovery_source: "main",
        },
        p,
      ),
    );
  }
  function alive(a: Assignment, seq: number, generation = 1) {
    events.send(
      {
        seq,
        type: "snapshot",
        source_generation: generation,
        observations: [
          {
            terminal_ref: f.refFor(a).terminal_ref,
            status: { process: "alive", agent: "idle", observed_seq: seq },
          },
        ],
      },
      subscription(a),
    );
  }
  return {
    f,
    target,
    events,
    monitor,
    owner,
    subscription,
    send,
    lose,
    confirm,
    recover,
    alive,
    close: async () => {
      await monitor.stop();
      f.close();
    },
  };
}

test("earlier recovered worker still blocks creating another successor while its exit is unconfirmed", async () => {
  const t = setup();
  try {
    const old = t.target.assignment;
    await t.lose(old);
    t.confirm();
    t.monitor.reconcile();
    const middle = t.recover("worker-b");
    t.f.session(middle, false);
    t.monitor.reconcile();
    await t.lose(middle);
    t.confirm();
    t.monitor.reconcile();
    expect(t.owner(old).status).toBe("released");
    expect(t.owner(middle).status).toBe("released");
    // The oldest machine comes back before the next reassignment.
    t.alive(old, 10);
    await setImmediate();
    expect(
      t.f.state().human_actions.filter((h) => h.status === "open"),
    ).toHaveLength(1);
    expect(hostOpsPending(t.f.state().events, middle.id)).toBe(true);
    const before = t.f.state().assignments.length;
    expect.soft(() => t.recover("local")).toThrow();
    expect.soft(t.f.state().assignments).toHaveLength(before);
    // Existing Run fence is tested separately; this does not claim that a Run starts.
    const current = t.f
      .state()
      .work_items.find((w) => w.id === t.target.item.id)?.assignment_id;
    if (!current) throw new Error("Missing current Assignment");
    expect(current).toBe(middle.id);
    expect(() =>
      t.f.apply((s, a, p) =>
        queueRun(
          s,
          a,
          {
            assignment_id: current,
            model: "fixture",
            agent_cli_version: "fixture",
          },
          p,
        ),
      ),
    ).toThrow();
    t.confirm();
    const next = t.recover("local");
    expect(next.id).not.toBe(middle.id);
    expect(t.f.state().assignments).toHaveLength(before + 1);
    expect(
      t.f.state().work_items.find((w) => w.id === t.target.item.id)
        ?.assignment_id,
    ).toBe(next.id);
    expect(t.recover("local").id).toBe(next.id);
    expect(t.f.state().assignments).toHaveLength(before + 1);
  } finally {
    await t.close();
  }
});

test("persistence failure rolls token revocation, Run settlement and Assignment release back together", async () => {
  const t = setup();
  try {
    const token = t.f.store.uow.run((tx) =>
      issueTokenInTransaction(tx, t.f.project, t.target.assignment.id, {
        role_version: 1,
        allowed_tools: ["finish_run"],
      }),
    );
    await t.lose(t.target.assignment);
    t.confirm();
    t.f.store.database.exec(
      "CREATE TEMP TRIGGER fail_remote_release BEFORE INSERT ON events WHEN NEW.type = 'remote_worker_released' BEGIN SELECT RAISE(ABORT, 'review injected persistence failure'); END",
    );
    expect(() => t.monitor.reconcile()).toThrow(
      "review injected persistence failure",
    );
    expect(t.f.store.verifyToken(token.token)).toBeDefined();
    expect(t.owner(t.target.assignment)).toMatchObject({
      status: "active",
      runtime_state: "lost",
    });
    expect(
      t.f.state().runs.find((r) => r.assignment_id === t.target.assignment.id)
        ?.status,
    ).toBe("unknown");
    expect(
      t.f.state().events.some((e) => e.type === "remote_worker_released"),
    ).toBe(false);
    t.f.store.database.exec("DROP TRIGGER fail_remote_release");
    t.monitor.reconcile();
    t.monitor.reconcile();
    expect(t.f.store.verifyToken(token.token)).toBeUndefined();
    expect(t.owner(t.target.assignment).status).toBe("released");
    expect(
      t.f.state().events.filter((e) => e.type === "remote_worker_released"),
    ).toHaveLength(1);
  } finally {
    await t.close();
  }
});

test("wrong terminal, old generation, lower and duplicate sequences cannot close or renew the lost-worker watch", async () => {
  const t = setup();
  try {
    const old = t.target.assignment;
    await t.lose(old);
    t.confirm();
    t.monitor.reconcile();
    t.send(old, 10, "lost", 2);
    await setImmediate();
    t.send(old, 11, "finished", 1);
    t.send(old, 9, "finished", 2);
    t.send(old, 10, "finished", 2);
    t.events.send(
      {
        seq: 11,
        type: "finished",
        source_generation: 2,
        terminal_ref: "another-terminal",
      },
      t.subscription(old),
    );
    await setImmediate();
    t.monitor.reconcile();
    expect(
      t.f.state().events.some((e) => e.type === "remote_worker_exit_observed"),
    ).toBe(false);
    expect(t.subscription(old)).toBeGreaterThanOrEqual(0);
    t.alive(old, 12, 2);
    await setImmediate();
    expect(
      t.f.state().human_actions.filter((h) => h.status === "open"),
    ).toHaveLength(1);
    t.confirm();
    t.alive(old, 12, 2);
    await setImmediate();
    expect(
      t.f.state().human_actions.filter((h) => h.status === "open"),
    ).toHaveLength(0);
    t.alive(old, 13, 2);
    await setImmediate();
    expect(
      t.f.state().human_actions.filter((h) => h.status === "open"),
    ).toHaveLength(1);
  } finally {
    await t.close();
  }
});
