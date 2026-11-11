import {
  type Assignment,
  acknowledgeRun,
  dispatchRun,
  issueInstruction,
  type Runtime,
  recordDecision,
  requestDecision,
} from "@cardigan/domain";
import { unfinishedBellAttempts } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

let f: ReturnType<typeof m3Fixture>;
let options: DispatcherOptions;
beforeEach(({ task }) => {
  f = m3Fixture("m3-acceptance", undefined, task.name.startsWith("assign"));
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: vi.fn(),
    release: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  options = {
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: vi.fn(async () => ({ model: "fixture", agent_cli_version: "1" })),
    startRun: vi.fn(async ({ run, assignment }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          {
            run_id: run.id,
            runtime_ref: {
              machine_id: "local",
              runtime_machine: "local",
              terminal_ref: assignment.id,
              agent_name: assignment.id,
            },
          },
          p,
        ),
      );
    }),
  };
});
afterEach(() => f.close());
const runs = (owner: Assignment) =>
  f.state().runs.filter((r) => r.assignment_id === owner.id);
const notes = (owner: Assignment) =>
  f.store.listNotifications({ project_id: f.id, assignment_id: owner.id });
const triggers = [
  "assign",
  "comment",
  "mention",
  "instruction",
  "decision",
] as const;
function trigger(
  kind: (typeof triggers)[number],
  owner: Assignment,
): Assignment {
  if (owner.scope !== "work_item") throw new Error("Expected work item owner");
  // This fixture assigned the verifier through the real PM command at setup.
  if (kind === "assign") return owner;
  if (kind === "comment") f.comment(f.human, owner.work_item_id);
  else if (kind === "mention") f.comment(f.human, undefined, [owner.id]);
  else if (kind === "instruction")
    f.apply((s, a, p) =>
      issueInstruction(
        s,
        a,
        {
          card_id: f.card.id,
          work_item_id: owner.work_item_id,
          body: "Check the current delivery",
        },
        p,
      ),
    );
  else {
    const q = f.apply(
      (s, a, p) =>
        requestDecision(
          s,
          a,
          {
            card_id: f.card.id,
            kind: "choose",
            category: "general",
            question: "Continue?",
            context: "Review input",
            decider: "human",
            blocking: false,
            options: [
              { key: "go", description: "Continue", impact: "Unblocks review" },
            ],
            recommended: "go",
            affected_cards: [f.card.id],
            affected_work_items: [],
          },
          p,
        ),
      f.actor(owner),
    ).data;
    f.apply((s, a, p) =>
      recordDecision(
        s,
        a,
        {
          decision_id: q.id,
          option: "go",
          rationale: "Ready",
          raw_quote: "go",
        },
        p,
      ),
    );
  }
  return owner;
}
async function product() {
  f.start(f.coder);
  return (await f.delivery()).data;
}
async function completion() {
  const code = await product();
  f.start(f.reviewer);
  f.review(code.id);
  f.finish(f.reviewer);
  return (await f.delivery("card_completion")).data;
}
const cases = triggers.flatMap((kind) =>
  [false, true].map((acceptance) => ({ kind, acceptance })),
);
test.each(cases)(
  "$kind waits durably for its own target (acceptance=$acceptance) and dispatches once",
  async ({ kind, acceptance }) => {
    const owner = trigger(kind, acceptance ? f.pm : f.reviewer);
    for (let i = 0; i < 2; i++) await new Dispatcher(options).tick();
    expect(runs(owner)).toEqual([]); // No queued or cancelled Run, even after restart.
    expect(notes(owner).length).toBeGreaterThan(0);
    expect(
      notes(owner).every(
        (n) => n.status === "pending" && n.attempts === 0 && !n.run_id,
      ),
    ).toBe(true);
    expect(unfinishedBellAttempts(f.store.database, f.id)).toEqual([]);
    expect(options.startRun).not.toHaveBeenCalled();
    const retained = notes(owner).map((n) => n.id);
    if (acceptance) await completion();
    else await product();
    await new Dispatcher(options).tick();
    expect(runs(owner)).toHaveLength(1);
    expect(runs(owner)[0]?.status).toBe("dispatched");
    expect(
      notes(owner)
        .filter((n) => retained.includes(n.id))
        .every((n) => n.status === "belled"),
    ).toBe(true);
    const run = runs(owner)[0];
    if (!run) throw new Error("Missing dispatched Run");
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actor(owner),
    );
    f.store.ackEvents({
      project_id: f.id,
      assignment_id: owner.id,
      card_id: f.card.id,
      up_to_seq: f.store.getUpdates({ project_id: f.id, card_id: f.card.id })
        .latest_seq,
    });
    f.finish(owner);
    await new Dispatcher(options).tick();
    expect(runs(owner)).toHaveLength(1);
    expect(notes(owner).every((n) => n.status === "acked")).toBe(true);
  },
);

test("a superseded completion retains comments and reuses a capacity-deferred Run without blocking a producer", async () => {
  await completion();
  options.runLimit = () => 1; // The coder still owns the only slot.
  await new Dispatcher(options).tick();
  const queued = runs(f.pm)[0];
  expect(queued).toMatchObject({
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  const next = (await f.delivery()).data; // Withdraws the old completion request.
  f.comment(f.human, undefined, [f.pm.id]);
  f.store.ackEvents({
    project_id: f.id,
    assignment_id: f.coder.id,
    card_id: f.card.id,
    up_to_seq: f.store.getUpdates({ project_id: f.id, card_id: f.card.id })
      .latest_seq,
  });
  f.finish(f.coder);
  const extra = f.extra("coder");
  const producer = f.assignItem(extra);
  f.comment(f.human, extra.id);
  await new Dispatcher(options).tick();
  expect(runs(f.pm)).toEqual([queued]);
  expect(notes(f.pm).every((n) => n.status === "pending")).toBe(true);
  // The older reviewer is dispatched first; after its review, the producer
  // must not be starved by the completion Run whose target was withdrawn.
  const reviewRun = runs(f.reviewer).find((r) => r.status === "dispatched");
  if (!reviewRun) throw new Error("Missing re-review Run");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: reviewRun.id }, p),
    f.actor(f.reviewer),
  );
  f.review(next.id);
  f.finish(f.reviewer);
  f.store.ackEvents({
    project_id: f.id,
    assignment_id: f.coder.id,
    card_id: f.card.id,
    up_to_seq: f.store.getUpdates({ project_id: f.id, card_id: f.card.id })
      .latest_seq,
  });
  await new Dispatcher(options).tick();
  expect(runs(producer)[0]?.status).toBe("dispatched");
  options.runLimit = () => 4;
  f.start(f.coder);
  await f.delivery("card_completion");
  await new Dispatcher(options).tick();
  expect(runs(f.pm)).toHaveLength(1);
  expect(runs(f.pm)[0]).toMatchObject({ id: queued?.id, status: "dispatched" });
});

test("claim rechecks a target withdrawn during async snapshot preparation", async () => {
  await completion();
  let withdraw = true;
  options.snapshot = async (owner) => {
    if (owner.id === f.pm.id && withdraw) {
      withdraw = false;
      await f.delivery();
    }
    return { model: "fixture", agent_cli_version: "1" };
  };
  await new Dispatcher(options).tick();
  expect(runs(f.pm)).toEqual([]);
  expect(
    notes(f.pm).every((n) => n.status === "pending" && n.attempts === 0),
  ).toBe(true);
  expect(unfinishedBellAttempts(f.store.database, f.id)).toEqual([]);
});
