/**
 * C-826: SEN-C-212 on a real store and dispatcher. A Run queued on a machine
 * whose godot slot stays taken moves, after the threshold, to a machine with
 * a free slot and starts there; nobody is notified.
 */
import type { Employee, MachinePlacement, Runtime } from "@cardigan/domain";
import {
  autoAssignProducer,
  createCard,
  dispatchRun,
  updateWorkItem,
} from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

let f: ReturnType<typeof dispatchFixture> | undefined;
afterEach(() => f?.close());

const healthy = (occupied: number): MachinePlacement => ({
  remote_binding: "allowed",
  observation_target_matches: true,
  health: { status: "passed", available: true },
  capabilities: [
    { key: "harness.pi", version: "1.0.0", available: true },
    { key: "godot", version: "4.4", available: true },
  ],
  limit: 4,
  occupied,
});

test("SEN-C-212: a queued Run moves to the machine with a free godot slot and starts there", async () => {
  const fx = dispatchFixture("worker");
  f = fx;
  fx.store.uow.run((tx) =>
    tx.machines.put(fx.project, {
      id: "local",
      label: "local",
      herdr_machine: "local",
      os: "linux",
      arch: "x64",
      tags: [],
      max_assignments: 4,
      status: "online",
      last_seen: fx.clock.now(),
    }),
  );
  // At assignment time local is full, so the system picks the worker.
  let localOccupied = 4;
  fx.store.setMachinePlacementReader(() => ({
    harness: "pi",
    machines: new Map([
      ["local", healthy(localOccupied)],
      ["worker", healthy(1)],
    ]),
  }));
  const godot = (item: string) =>
    fx.apply((s, a, p) =>
      updateWorkItem(
        s,
        a,
        {
          work_item_id: item as never,
          requirements: { capabilities: ["godot"] },
        },
        p,
      ),
    );
  // R-5342/R-5476 stand-in: a long Run holds the worker's only godot slot.
  const busy = fx.create();
  godot(busy.item.id);
  fx.session(busy.assignment, false);
  const card = fx.apply((s, a, p) =>
    createCard(
      s,
      a,
      {
        title: "Tablet",
        goal: "Ship on the tablet",
        acceptance_criteria: ["runs"],
        repo: "fixture/repo",
        base_branch: "main",
        source: { kind: "quote", text: "fixture" },
      },
      p,
    ),
  );
  const item = fx
    .state()
    .work_items.find((w) => w.card_id === card.id && w.kind === "produce");
  if (!item) throw new Error("Missing work item");
  godot(item.id);
  fx.store.uow.run((tx) =>
    tx.employees.put({
      id: "E-13",
      name: "Guan Yu",
      title: "Coder",
      bio: "",
      avatar: null,
      role_id: "coder",
      launch_profile_ref: null,
      status: "active",
      created_at: fx.clock.now(),
      updated_at: fx.clock.now(),
    } as Employee),
  );
  const queued = fx.apply(
    (s, a, p) => autoAssignProducer(s, a, { work_item_id: item.id }, p),
    { kind: "system", project_id: fx.project },
  );
  expect(queued?.machine_id).toBe("worker");
  if (!queued) throw new Error("Missing assignment");
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: async () => {
      throw new Error("use host callback");
    },
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    interrupt: async () => ({ ok: true, value: undefined }),
    resume_or_replace: async () => {
      throw new Error("unused");
    },
    human_entry: async () => ({ ok: true, value: "fixture" }),
  };
  const options: DispatcherOptions = {
    store: fx.store,
    runtime,
    clock: fx.clock,
    deliveryLeaseMs: 1000,
    runLimit: () => 4,
    resourceLimits: () => new Map([["godot", 1]]),
    snapshot: vi.fn(async () => ({ model: "m", agent_cli_version: "c" })),
    startRun: vi.fn(async ({ run, assignment }) => {
      fx.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: fx.refFor(assignment) },
          p,
        ),
      );
    }),
  };
  const dispatcher = new Dispatcher(options);
  await dispatcher.tick();
  const first = fx.state().runs.find((r) => r.assignment_id === queued.id);
  expect(first).toMatchObject({
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  // Local frees up; before the threshold nothing moves.
  localOccupied = 0;
  fx.advance(4 * 60_000);
  await dispatcher.tick();
  expect(
    fx.state().work_items.find((w) => w.id === item.id)?.assignment_id,
  ).toBe(queued.id);
  const others = () =>
    fx.store
      .listNotifications({ project_id: fx.project })
      .filter((n) => n.recipient.kind !== "assignment")
      .map((n) => n.id);
  const before = others();
  fx.advance(60_000);
  await dispatcher.tick();
  await dispatcher.tick();
  const state = fx.state();
  const successor = state.work_items.find(
    (w) => w.id === item.id,
  )?.assignment_id;
  expect(successor).not.toBe(queued.id);
  expect(state.assignments.find((a) => a.id === successor)).toMatchObject({
    machine_id: "local",
    status: "active",
    recovery: { previous_assignment_id: queued.id },
  });
  expect(state.assignments.find((a) => a.id === queued.id)?.status).toBe(
    "released",
  );
  expect(state.runs.find((r) => r.id === first?.id)?.status).toBe("cancelled");
  expect(state.runs.filter((r) => r.assignment_id === successor)).toMatchObject(
    [{ status: "dispatched" }],
  );
  const line = state.timeline.find(
    (t) => t.card_id === card.id && t.body.includes("已自动改到"),
  );
  expect(line?.body).toBe(
    `${first?.id} 在 worker 排队 5 分钟（godot 名额 1 已用满），已自动改到 local：${queued.id} → ${successor}`,
  );
  // Neither PM Ops nor the human is asked about it.
  expect(others()).toEqual(before);
});
