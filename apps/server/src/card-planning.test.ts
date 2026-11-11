import {
  type Actor,
  type Assignment,
  acknowledgeRun,
  assign,
  type CardId,
  createCard,
  dispatchRun,
  finishRun,
  projectSnapshot,
  type Runtime,
  updateCard,
} from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { rotateStandingPmInStore } from "../../cli/src/pm-rotate.js";
import { dispatchFixture } from "../test-support/dispatch.js";
import { standingResolver } from "./assembly.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { acknowledgeInbox, routeProjectEvents } from "./dispatch-inbox.js";

let f: ReturnType<typeof dispatchFixture>;
let ops: Assignment;
let office: Assignment;
let options: DispatcherOptions;
let duringDelivery: (() => void) | undefined;
const definition = defaultRoleDefinition("pm", {
  harness: "pi",
  launch_profile_ref: "fixture",
});
const role = {
  ...definition,
  version: 1,
  core_prompt: "Fixture",
  worktree: "none" as const,
};

beforeEach(() => {
  f = dispatchFixture();
  duringDelivery = undefined;
  [ops, office] = f.store.uow.run((tx) => {
    writeRole(tx, f.project, role, { mode: "add" });
    return (["ops", "office"] as const).map((standing_mode) => {
      const a: Assignment = {
        id: tx.ids.next(f.project, "assignment"),
        scope: "standing",
        standing_mode,
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        runtime_ref: null,
        machine_id: "local",
        mcp_token_id: `pm-${standing_mode}`,
        created_at: f.clock.now(),
      };
      tx.assignments.put(f.project, a);
      return a;
    }) as [Assignment, Assignment];
  });
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  options = {
    store: f.store,
    runtime,
    clock: f.clock,
    standing: standingResolver(f.store),
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    startRun: vi.fn(async ({ run, assignment }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
      const callback = duringDelivery;
      duringDelivery = undefined;
      callback?.();
    }),
  };
});
afterEach(() => f.close());

const create = (actor?: Actor) =>
  f.apply(
    (s, a, p) =>
      createCard(
        s,
        a,
        {
          title: "New work",
          goal: "Must reach Ops without a mention",
          acceptance_criteria: ["assigned"],
          repo: "fixture/repo",
          base_branch: "main",
          source: { kind: "quote", text: "New requirement" },
        },
        p,
      ),
    actor,
  );
const notes = () =>
  f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.kind === "card");
const rotate = () => {
  f.store.uow.run((tx) => writeRole(tx, f.project, role, { mode: "update" }));
  return rotateStandingPmInStore(f.store, f.project, "ops").assignment;
};

test.each(["human", "office"] as const)(
  "%s cards reach the current Ops across every rotation window",
  async (creator) => {
    const actor = creator === "office" ? f.actorFor(office) : undefined;
    // One acknowledged old stream must not hide seq=1 of a different new card.
    const handled = create(actor);
    const old = ops;
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: old.id,
      card_id: handled.id,
      up_to_seq: 1,
    });
    routeProjectEvents(f.store, f.project);
    acknowledgeInbox(f.store, f.project, options.standing, f.clock);

    const beforeRoute = create(actor);
    ops = rotate();
    await new Dispatcher(options).tick();
    expect(notes().find((n) => n.card_id === beforeRoute.id)?.status).toBe(
      "belled",
    );
    expect(f.state().runs.at(-1)?.assignment_id).toBe(ops.id);
    expect(notes().find((n) => n.card_id === handled.id)?.status).toBe("acked");

    // These were delivered but not ACKed. Rotation clears the old Run binding.
    const belledOwner = ops;
    ops = rotate();
    expect(notes().find((n) => n.card_id === beforeRoute.id)).toMatchObject({
      status: "pending",
    });
    expect(
      notes().find((n) => n.card_id === beforeRoute.id)?.run_id,
    ).toBeUndefined();
    await new Dispatcher(options).tick();
    expect(f.state().runs.at(-1)?.assignment_id).toBe(ops.id);
    expect(
      f
        .state()
        .runs.filter((r) => r.assignment_id === belledOwner.id)
        .every((r) => r.status === "cancelled"),
    ).toBe(true);

    // A failed delivery also survives replacement without reusing the old Run.
    const sent = notes().find((n) => n.card_id === beforeRoute.id);
    if (!sent) throw new Error("Missing new-card notification");
    f.store.moveNotification({
      project_id: f.project,
      id: sent.id,
      event: "deliver_failed",
    });
    ops = rotate();
    const pending = create(actor);
    routeProjectEvents(f.store, f.project);
    ops = rotate();
    const afterRotate = create(actor);
    // Different card streams ring serially while Ops has a running turn.
    const received = new Set<CardId>();
    for (let turn = 0; turn < 3; turn++) {
      await new Dispatcher(options).tick();
      const note = notes().find((n) => n.status === "belled");
      if (!note?.card_id || !note.run_id) throw new Error("Missing card bell");
      const run_id = note.run_id;
      expect(
        f.state().runs.find((r) => r.id === note.run_id)?.assignment_id,
      ).toBe(ops.id);
      received.add(note.card_id);
      if (turn === 2) break;
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id }, p),
        f.actorFor(ops),
      );
      f.store.ackEvents({
        project_id: f.project,
        assignment_id: ops.id,
        card_id: note.card_id,
        up_to_seq: note.seq,
      });
      acknowledgeInbox(f.store, f.project, options.standing, f.clock);
      f.apply(
        (s, a, p) =>
          finishRun(
            s,
            a,
            {
              run_id,
              outcome: "completed",
              summary: "Read new card",
            },
            p,
          ),
        f.actorFor(ops),
      );
    }
    expect(received).toEqual(
      new Set([beforeRoute.id, pending.id, afterRotate.id]),
    );
    expect(
      vi
        .mocked(options.startRun)
        .mock.calls.every(([call]) => call.assignment.id !== office.id),
    ).toBe(true);

    // The replacement reads the actual card and can assign its produce item.
    const run = f
      .state()
      .runs.find(
        (r) => r.assignment_id === ops.id && r.status === "dispatched",
      );
    if (!run) throw new Error("Missing Ops run");
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actorFor(ops),
    );
    const item = f
      .state()
      .work_items.find(
        (w) => w.card_id === afterRotate.id && w.kind === "produce",
      );
    if (!item) throw new Error("Missing produce item");
    const assigned = f.apply(
      (s, a, p) => assign(s, a, { work_item_id: item.id, role_id: "coder" }, p),
      f.actorFor(ops),
    );
    expect(assigned.work_item_id).toBe(item.id);
    for (const note of notes())
      f.store.ackEvents({
        project_id: f.project,
        assignment_id: ops.id,
        card_id: note.card_id,
        up_to_seq: note.seq,
      });
    acknowledgeInbox(f.store, f.project, options.standing, f.clock);
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          {
            run_id: run.id,
            outcome: "completed",
            summary: "Assigned new work",
          },
          p,
        ),
      f.actorFor(ops),
    );
    const count = f
      .state()
      .runs.filter((r) => r.assignment_id === ops.id).length;
    await new Dispatcher(options).tick();
    expect(
      f.state().runs.filter((r) => r.assignment_id === ops.id),
    ).toHaveLength(count);
  },
);

test("rotation during an in-flight delivery preserves new-card work despite the late result", async () => {
  const card = create();
  duringDelivery = () => {
    ops = rotate();
  };
  await new Dispatcher(options).tick();
  expect(notes()).toMatchObject([{ status: "pending" }]);
  await new Dispatcher(options).tick();
  expect(notes()).toMatchObject([{ card_id: card.id, status: "belled" }]);
  expect(f.state().runs.at(-1)?.assignment_id).toBe(ops.id);
});

test("promotion is discovered after creation was ACKed, and title edits do not ring again", () => {
  const card = create();
  routeProjectEvents(f.store, f.project);
  f.store.ackEvents({
    project_id: f.project,
    assignment_id: ops.id,
    card_id: card.id,
    up_to_seq: 1,
  });
  acknowledgeInbox(f.store, f.project, options.standing, f.clock);
  for (const update of [
    { status: "backlog" as const },
    { status: "todo" as const },
    { title: "Rename" },
  ])
    f.apply((s, a, p) => updateCard(s, a, { card_id: card.id, ...update }, p));
  routeProjectEvents(f.store, f.project);
  expect(notes().filter((n) => n.status === "pending")).toMatchObject([
    { seq: 3 },
  ]);
  // Snapshot is the fallback for cards already consumed by an older Router.
  expect(projectSnapshot(f.state(), f.actorFor(ops))).toMatchObject({
    ok: true,
    value: {
      data: {
        cards: [expect.objectContaining({ id: card.id, status: "todo" })],
      },
    },
  });
});
