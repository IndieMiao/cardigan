import {
  type Actor,
  type Assignment,
  HELD_RESUME_TRIGGER,
  issueInstruction,
  resolveDelegatedDecision,
  stoppedByHuman,
  stopWorkItemAssignment,
  updateCard,
} from "@cardigan/domain";
import { getRoleVersion, writeRole } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

// C-732 regression (C-603 / A-1955): a human pause on an open card kept its
// instructions pending for 33 hours. The stall alert only reached host_ops,
// which cannot end a pause. Real SQLite, fake runtime, no CPU load.
function scenario() {
  const f = setup();
  const a = f.target.assignment;
  // PM Ops that may resolve delegated decisions (permission is delegated by default).
  const pm = f.pm();
  const ops = f.store.uow.run((tx) => {
    const role = getRoleVersion(tx, f.project, "pm");
    if (!role) throw new Error("Missing pm role");
    const next = writeRole(
      tx,
      f.project,
      {
        ...role,
        allowed_tools: [...role.allowed_tools, "resolve_delegated_decision"],
      },
      { mode: "update" },
    ).role;
    const ops: Assignment = {
      ...pm,
      standing_mode: "ops",
      role_version: next.version,
    };
    tx.assignments.put(f.project, ops);
    return { assignment: ops, role: next };
  });
  const pmActor: Actor = {
    kind: "assignment",
    project_id: f.project,
    assignment_id: ops.assignment.id,
    role_id: "pm",
    role_version: ops.role.version,
    allowed_tools: ops.role.allowed_tools,
    capabilities: ops.role.capabilities,
  };
  // `cardigan assignment stop --hold`, then the settled terminal release.
  const ref = f.state().assignments.find((x) => x.id === a.id)?.runtime_ref;
  if (!ref) throw new Error("Missing terminal");
  for (const released of [undefined, ref])
    f.apply((s, actor, p) =>
      stopWorkItemAssignment(
        s,
        actor,
        {
          assignment_id: a.id,
          reason: "人工暂停",
          hold: true,
          ...(released ? { released_runtime_ref: released } : {}),
        },
        p,
      ),
    );
  const instruct = () =>
    f.apply((s, actor, p) =>
      issueInstruction(
        s,
        actor,
        {
          card_id: f.target.card.id,
          work_item_id: f.target.item.id,
          body: "按退回意见修复",
        },
        p,
      ),
    );
  const resumeQuestion = () =>
    f.state().decisions.find((q) => q.trigger === HELD_RESUME_TRIGGER);
  const starts = () =>
    vi
      .mocked(f.options.startRun)
      .mock.calls.filter(([c]) => c.assignment.id === a.id).length;
  return { f, a, pmActor, instruct, resumeQuestion, starts };
}

test("a paused Assignment with an instruction waiting past 30 minutes is offered to PM Ops; resuming starts a new Run and informs the human", async () => {
  vi.stubEnv("CARDIGAN_DISPATCH_STALL_MS", "600000");
  const { f, a, pmActor, instruct, resumeQuestion, starts } = scenario();
  instruct();
  const dispatcher = new Dispatcher(f.options);
  await dispatcher.tick();
  expect(starts()).toBe(0);
  expect(f.notes().map((n) => n.status)).toEqual(["pending"]);

  // Below the threshold: no question yet.
  f.advance(29 * 60_000);
  await f.service.tick();
  expect(resumeQuestion()).toBeUndefined();

  f.advance(2 * 60_000);
  await f.service.tick();
  await vi.waitFor(() => expect(resumeQuestion()).toBeDefined());
  const q = resumeQuestion();
  expect(q).toMatchObject({
    decider: "role:pm",
    category: "permission",
    assignment_id: a.id,
    held_pause: { by: "human" },
  });
  await dispatcher.tick();
  const toOps = f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.recipient.kind === "pm_ops");
  expect(
    toOps.some(
      (n) =>
        f.state().events.find((e) => e.id === n.event_id)?.type ===
        "decision_requested",
    ),
  ).toBe(true);

  // The human_stopped stall alert names the pause and never goes to host_ops.
  const stall = f
    .state()
    .events.find(
      (e) =>
        e.type === "dispatch_stall_attention" &&
        (e.payload as { assignment_id?: string }).assignment_id === a.id,
    );
  expect(stall?.payload).toMatchObject({
    restart_blocked: "human_stopped",
    paused_by: "human",
    handled_by: "pm_ops",
  });
  const stallNotes = f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.event_id === stall?.id);
  expect(stallNotes.map((n) => n.recipient)).toEqual([{ kind: "pm_ops" }]);

  // A second patrol pass does not ask again.
  f.advance(60_000);
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f.state().decisions.filter((d) => d.trigger === HELD_RESUME_TRIGGER),
    ).toHaveLength(1),
  );

  // PM Ops answers with one call; the next dispatch starts exactly one Run.
  f.apply(
    (s, actor, p) =>
      resolveDelegatedDecision(
        s,
        actor,
        {
          decision_id: q?.id as never,
          option: "resume",
          rationale: "卡片在进行，待办排队",
        },
        p,
      ),
    pmActor,
  );
  expect(stoppedByHuman(f.state().events, a.id)).toBe(false);
  const resumed = f
    .state()
    .events.find((e) => e.type === "assignment_hold_resumed");
  expect(resumed?.actor).toMatchObject({
    kind: "assignment",
    assignment_id: pmActor.kind === "assignment" ? pmActor.assignment_id : "",
  });
  await dispatcher.tick();
  await dispatcher.tick();
  expect(starts()).toBe(1);
  expect(
    f
      .state()
      .runs.filter(
        (r) =>
          r.assignment_id === a.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      ),
  ).toHaveLength(1);
  const informed = f.store
    .listNotifications({ project_id: f.project })
    .find(
      (n) => n.recipient.kind === "needs_you" && n.event_id === resumed?.id,
    );
  expect(informed).toBeDefined();
});

test("a pause without waiting work, or on a held card, is neither offered nor resumed", async () => {
  const { f, a, instruct, resumeQuestion, starts } = scenario();
  f.advance(60 * 60_000);
  // The patrol's resume check runs synchronously at the start of its pass.
  await f.service.tick();
  expect(resumeQuestion()).toBeUndefined();

  // Card held: work queued while held is the card's wait, not the pause's.
  f.apply((s, actor, p) =>
    updateCard(
      s,
      actor,
      {
        card_id: f.target.card.id,
        hold: { reason: "等现场", resume_condition: "现场核对完" },
      },
      p,
    ),
  );
  instruct();
  await new Dispatcher(f.options).tick();
  f.advance(60 * 60_000);
  // The patrol's resume check runs synchronously at the start of its pass.
  await f.service.tick();
  expect(resumeQuestion()).toBeUndefined();
  expect(stoppedByHuman(f.state().events, a.id)).toBe(true);
  expect(starts()).toBe(0);
  // The held card, not the pause, explains this wait; it stays with host_ops.
  const stall = f
    .state()
    .events.find(
      (e) =>
        e.type === "dispatch_stall_attention" &&
        (e.payload as { assignment_id?: string }).assignment_id === a.id,
    );
  expect(stall?.payload).toMatchObject({ restart_blocked: "card_held" });
  expect(stall?.payload).not.toHaveProperty("paused_by");
  expect(
    f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.event_id === stall?.id)
      .map((n) => n.recipient),
  ).toEqual([{ kind: "assignment", assignment_id: f.ops.id }]);
});

test("releasing the card hold lists the paused Assignment with its resume entry", async () => {
  const { f, a, resumeQuestion } = scenario();
  const hold = { reason: "等现场", resume_condition: "现场核对完" };
  f.apply((s, actor, p) =>
    updateCard(s, actor, { card_id: f.target.card.id, hold }, p),
  );
  f.apply((s, actor, p) =>
    updateCard(s, actor, { card_id: f.target.card.id, hold: null }, p),
  );
  const q = resumeQuestion();
  expect(q).toBeDefined();
  await new Dispatcher(f.options).tick();
  const released = f
    .state()
    .events.find((e) => e.type === "card_hold_released");
  const toYou = f.store
    .listNotifications({ project_id: f.project })
    .find(
      (n) => n.recipient.kind === "needs_you" && n.event_id === released?.id,
    );
  expect(toYou).toBeDefined();
  expect(
    f.state().timeline.find((t) => t.event_seq === released?.seq)?.body,
  ).toContain(`${a.id}（${f.target.item.id}，人于`);
  expect(
    f.state().timeline.find((t) => t.event_seq === released?.seq)?.body,
  ).toContain(`在 ${q?.id} 一键恢复`);
});
