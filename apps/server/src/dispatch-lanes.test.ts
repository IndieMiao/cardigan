import type { AssignmentId, Runtime } from "@cardigan/domain";
import { dispatchRun, postComment } from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { LaunchLanes } from "./dispatch-lanes.js";

const A = (n: number) => `A-${n}` as AssignmentId;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

test("C-788: lanes overlap machines up to the limit and keep each machine and Assignment in order", async () => {
  const lanes = new LaunchLanes(2);
  const log: string[] = [];
  const gates = new Map<string, ReturnType<typeof gate>>();
  const work = (name: string) => async () => {
    log.push(`start ${name}`);
    const g = gate();
    gates.set(name, g);
    await g.opened;
    log.push(`end ${name}`);
  };
  const first = await lanes.acquire(A(1), "m1");
  first.run(work("a1"), () => log.push("after a1"));
  const second = await lanes.acquire(A(2), "m2");
  second.run(work("a2"));
  // Same machine: waits for a1's lane even though the overall limit is free.
  let third: Promise<unknown> = lanes.acquire(A(3), "m1");
  let settled = false;
  void third.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  gates.get("a1")?.open();
  const slot = await third;
  expect(log).toEqual(["start a1", "start a2", "end a1", "after a1"]);
  (slot as Awaited<ReturnType<LaunchLanes["acquire"]>>).run(work("a3"));
  // Overall limit 2 (a2 and a3 running): a third machine waits.
  third = lanes.acquire(A(4), "m3");
  settled = false;
  void third.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  gates.get("a2")?.open();
  ((await third) as Awaited<ReturnType<LaunchLanes["acquire"]>>).release();
  // The same Assignment waits for its previous delivery.
  const idle = lanes.idle(A(3));
  gates.get("a3")?.open();
  await idle;
  await lanes.drain();
  expect(log).toEqual([
    "start a1",
    "start a2",
    "end a1",
    "after a1",
    "start a3",
    "end a2",
    "end a3",
  ]);
});

test("C-788: drain waits for every delivery and rethrows the first failure", async () => {
  const lanes = new LaunchLanes(3);
  const done: string[] = [];
  (await lanes.acquire(A(1), "m1")).run(async () => {
    throw new Error("first");
  });
  (await lanes.acquire(A(2), "m2")).run(async () => {
    await new Promise((r) => setTimeout(r, 5));
    done.push("a2");
  });
  await expect(lanes.drain()).rejects.toThrow("first");
  expect(done).toEqual(["a2"]);
  expect(() => new LaunchLanes(0)).toThrow("Invalid launch concurrency");
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** Three new sessions in FIFO order: w1, w2, then w1 again. */
async function threeStarts(launchConcurrency: number) {
  const f = dispatchFixture("w1");
  cleanup.push(() => f.close());
  f.store.uow.run((tx) => {
    const w1 = tx.machines.get(f.project, "w1");
    if (!w1) throw new Error("missing machine");
    tx.machines.put(f.project, { ...w1, max_assignments: 4 });
    tx.machines.put(f.project, {
      id: "w2",
      label: "Second worker",
      herdr_machine: "w2",
      os: "linux",
      arch: "x64",
      tags: [],
      max_assignments: 4,
      status: "online",
      last_seen: f.clock.now(),
    });
  });
  const started: string[] = [];
  const active = new Map<string, number>();
  let overall = 0,
    peak = 0;
  const machinePeak = new Map<string, number>();
  const gates = new Map<string, ReturnType<typeof gate>>();
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true as const,
      value: {
        process: "alive" as const,
        agent: "idle" as const,
        observed_seq: 1,
      },
    })),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
    provision: async () => {
      throw new Error("use host callback");
    },
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
    interrupt: async () => ({ ok: true as const, value: undefined }),
    resume_or_replace: async () => {
      throw new Error("unused");
    },
    human_entry: async () => ({ ok: true as const, value: "fixture" }),
  };
  const options: DispatcherOptions = {
    roleUpgradePass: "beside",
    store: f.store,
    runtime,
    clock: f.clock,
    runLimit: () => 4,
    launchConcurrency,
    snapshot: async () => ({ model: "m", agent_cli_version: "1" }),
    startRun: async ({ run, assignment }) => {
      const machine = assignment.machine_id;
      started.push(assignment.id);
      overall++;
      peak = Math.max(peak, overall);
      active.set(machine, (active.get(machine) ?? 0) + 1);
      machinePeak.set(
        machine,
        Math.max(machinePeak.get(machine) ?? 0, active.get(machine) ?? 0),
      );
      const g = gate();
      gates.set(assignment.id, g);
      await g.opened;
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
      overall--;
      active.set(machine, (active.get(machine) ?? 1) - 1);
    },
  };
  const dispatcher = new Dispatcher(options);
  cleanup.push(() => void dispatcher.close());
  // The first pass of idle role maintenance runs (and settles) before the
  // work arrives, so delivery is not deferred behind it.
  await dispatcher.tick();
  await dispatcher.roleUpgradesSettled();
  const targets = [f.create("w1"), f.create("w2"), f.create("w1")];
  for (const t of targets) {
    // Distinct times: FIFO order, not the random notification-id tie-break.
    f.advance(1_000);
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        { card_id: t.card.id, work_item_id: t.item.id, body: "Start" },
        p,
      ),
    );
  }
  const owners = targets.map((t) => t.assignment);
  return {
    f,
    owners,
    started,
    gates,
    dispatcher,
    peak: () => peak,
    machinePeak,
    running: () => overall,
  };
}

test("C-788: post-claim starts overlap across machines, never on one machine, in FIFO claim order", async () => {
  const t = await threeStarts(2);
  const [a1, a2, a3] = t.owners.map((a) => a.id);
  const tick = t.dispatcher.tick();
  await vi.waitFor(() => expect(t.started).toEqual([a1, a2]));
  // w1 is busy with a1: a3 waits for that lane, not for w2.
  expect(t.running()).toBe(2);
  t.gates.get(a2 as string)?.open();
  await new Promise((r) => setTimeout(r, 20));
  expect(t.started).toEqual([a1, a2]);
  t.gates.get(a1 as string)?.open();
  await vi.waitFor(() => expect(t.started).toEqual([a1, a2, a3]));
  t.gates.get(a3 as string)?.open();
  await tick;
  expect(t.peak()).toBe(2);
  expect(t.machinePeak.get("w1")).toBe(1);
  expect(
    t.f
      .state()
      .runs.filter((r) => r.status === "dispatched")
      .map((r) => r.assignment_id)
      .sort(),
  ).toEqual([a1, a2, a3].sort());
});

test("C-788: a launch limit of one keeps the old one-at-a-time delivery", async () => {
  const t = await threeStarts(1);
  const [a1, a2, a3] = t.owners.map((a) => a.id);
  const tick = t.dispatcher.tick();
  await vi.waitFor(() => expect(t.started).toEqual([a1]));
  await new Promise((r) => setTimeout(r, 20));
  expect(t.started).toEqual([a1]);
  t.gates.get(a1 as string)?.open();
  await vi.waitFor(() => expect(t.started).toEqual([a1, a2]));
  t.gates.get(a2 as string)?.open();
  await vi.waitFor(() => expect(t.started).toEqual([a1, a2, a3]));
  t.gates.get(a3 as string)?.open();
  await tick;
  expect(t.peak()).toBe(1);
});
