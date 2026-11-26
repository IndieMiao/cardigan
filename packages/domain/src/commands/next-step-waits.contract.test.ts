import { beforeEach, expect, test } from "vitest";
import type { Actor, WorkItem } from "../entities.js";
import type { ResumeCondition } from "../work-wait.js";
import { reportBlocker, requestHumanAction } from "./coordination.js";
import type { CommandState } from "./core.js";
import { finishRun } from "./runtime.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";
import { resumeWorkWaits } from "./work-waits.js";

/**
 * C-789 contract: a Run never ends without a registered next step, and a
 * delivered/accepted producer can wait for a baseline or a resource without
 * any state transition (§4.4), woken once by the system (§4.5 inv. 10: never
 * by its own Run).
 */
const system: Actor = { kind: "system", project_id: human.project_id };
const work = id("work_item", 1);
const owner = id("assignment", 1);
const runId = id("run", 1);
const base = "a".repeat(40);
const next = "b".repeat(40);
let io = ports();
let state = fixture();

function setItem(patch: Partial<WorkItem>) {
  state = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === work ? ({ ...w, ...patch } as WorkItem) : w,
    ),
    assignments: state.assignments.map((a) =>
      a.id === owner ? { ...a, base_sha: base } : a,
    ),
  };
}
beforeEach(() => {
  io = ports();
  state = fixture();
  setItem({ requirements: { capabilities: ["godot>=4"] } });
});
const item = () => state.work_items.find((w) => w.id === work) as WorkItem;
const run = () => state.runs.find((r) => r.id === runId);
function finish(
  outcome: "completed" | "blocked",
  wait_for?: Parameters<typeof finishRun>[2]["wait_for"],
) {
  const effect = value(
    finishRun(
      state,
      actor(),
      {
        run_id: runId,
        outcome,
        summary: "No godot slot in this Run",
        ...(wait_for ? { wait_for } : {}),
      },
      io,
    ),
  );
  state = apply(state, effect);
  return effect;
}
function report(resume_when?: ResumeCondition) {
  const effect = value(
    reportBlocker(
      state,
      actor(),
      {
        work_item_id: work,
        reason: "Need the emulator recording",
        needs: "role",
        ...(resume_when ? { resume_when } : {}),
      },
      io,
    ),
  );
  state = apply(state, effect);
  return effect;
}
function scan(baseline?: string) {
  const effect = value(
    resumeWorkWaits(
      state,
      system,
      baseline ? { baseline: { branch: "main", sha: baseline } } : {},
      io,
    ),
  );
  state = apply(state, effect);
  return effect;
}
const types = (e: { events: readonly { type: string }[] }) =>
  e.events.map((x) => x.type);

test("finish_run(blocked) without a blocker is accepted and the system registers one for PM", () => {
  const effect = finish("blocked");
  expect(run()).toMatchObject({ status: "completed", outcome: "blocked" });
  expect(item()).toMatchObject({
    status: "blocked",
    reported_blocker: { needs: "role", auto_registered: true },
  });
  expect(item().reported_blocker?.resume_when).toBeUndefined();
  expect(item().reported_blocker?.reason).toContain(runId);
  expect(types(effect)).toEqual(["blocker_reported", "run_finished"]);
  // No resume condition: the router sends it to the PM Ops queue.
  expect(effect.events[0]).toMatchObject({
    actor: system,
    payload: { work_item_id: work, run_id: runId, auto_registered: true },
  });
});

test("an Agent's own blocker, human action or completed finish adds nothing", () => {
  report();
  expect(types(finish("blocked"))).toEqual(["run_finished"]);
  expect(item().reported_blocker?.auto_registered).toBeUndefined();

  state = fixture();
  state = apply(
    state,
    value(
      requestHumanAction(
        state,
        actor(),
        {
          card_id: id("card", 1),
          instructions: "Rotate the key",
          why_human: "Credential",
          expected_return: "Done",
          blocked_work_items: [],
        },
        io,
      ),
    ),
  );
  expect(types(finish("blocked"))).toEqual(["run_finished"]);
  expect(item().status).toBe("in_progress");

  state = fixture();
  expect(types(finish("completed"))).toEqual(["run_finished"]);
  expect(item().status).toBe("in_progress");
});

test.each(["delivered", "accepted"] as const)(
  "a blocked %s producer gets a PM standby record and keeps its state",
  (status) => {
    setItem({ status });
    const effect = finish("blocked");
    expect(run()).toMatchObject({ status: "completed", outcome: "blocked" });
    expect(item().status).toBe(status);
    expect(item().reported_blocker).toBeUndefined();
    expect(item().standby_wait).toMatchObject({
      auto_registered: true,
      registered_by: "system",
      run_id: runId,
    });
    expect(item().standby_wait?.condition).toBeUndefined();
    expect(types(effect)).toEqual([
      "work_item_standby_registered",
      "run_finished",
    ]);
    // Nothing to verify: the system never wakes it; PM handles it.
    expect(scan(next).data).toEqual([]);
    expect(item().standby_wait).toBeDefined();
  },
);

test.each(["delivered", "accepted"] as const)(
  "a %s producer waits for the baseline without a state change and is woken once",
  (status) => {
    setItem({ status });
    const effect = finish("completed", { kind: "baseline_updated" });
    expect(run()?.wait_for).toBeUndefined();
    expect(item()).toMatchObject({
      status,
      standby_wait: {
        condition: { kind: "baseline_updated", target_id: base },
        registered_by: `assignment:${owner}`,
      },
    });
    expect(types(effect)).toEqual([
      "work_item_standby_registered",
      "run_finished",
    ]);
    expect(scan().data).toEqual([]);
    expect(scan(base).data).toEqual([]);
    const woken = scan(next);
    expect(woken.data).toEqual([work]);
    expect(item().status).toBe(status);
    expect(item().standby_wait).toBeUndefined();
    expect(woken.events[0]).toMatchObject({
      type: "work_item_resume_requested",
      actor: system,
      payload: {
        work_item_id: work,
        assignment_id: owner,
        automatic_wait: true,
        standby: true,
        condition: { kind: "baseline_updated", target_id: base },
        evidence: next,
        previous_run_id: runId,
      },
    });
    expect(scan(next).data).toEqual([]);
  },
);

test("an accepted producer waits for a resource; the wake waits for its own Run to end", () => {
  setItem({ status: "accepted" });
  const guidance = report({ kind: "resource_available", target_id: "godot" });
  expect(guidance.data.guidance).toContain("工作项状态不变");
  expect(item().status).toBe("accepted");
  expect(item().standby_wait?.condition).toEqual({
    kind: "resource_available",
    target_id: "godot",
  });
  // Never woken by its own Run (invariant 10).
  expect(scan().data).toEqual([]);
  finish("completed");
  const woken = scan();
  expect(woken.data).toEqual([work]);
  expect(woken.events[0]?.payload).toMatchObject({
    standby: true,
    condition: { kind: "resource_available", target_id: "godot" },
    evidence: "resource:godot",
  });
  expect(item().status).toBe("accepted");
});

test("the same condition resumes once; a repeated registration goes to PM", () => {
  setItem({ status: "accepted" });
  finish("completed", { kind: "resource_available", target_id: "godot" });
  expect(scan().data).toEqual([work]);
  state = {
    ...state,
    runs: state.runs.map((r) =>
      r.id === runId ? { ...r, status: "running", outcome: null } : r,
    ),
  };
  const again = report({ kind: "resource_available", target_id: "godot" });
  expect(again.data.guidance).toContain("交 PM");
  expect(item().standby_wait?.auto_resume_disabled).toBe(true);
  expect(again.events[0]?.payload).toMatchObject({
    auto_resume_disabled: true,
  });
  finish("completed");
  expect(scan().data).toEqual([]);
});

test("standby waits are validated and never accept an unrelated condition", () => {
  setItem({ status: "delivered" });
  // Not a resource this item requires.
  expect(
    finishRun(
      state,
      actor(),
      {
        run_id: runId,
        outcome: "completed",
        summary: "x",
        wait_for: { kind: "resource_available", target_id: "ios.simulator" },
      },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  // The Run already holds it.
  const held: CommandState = {
    ...state,
    runs: state.runs.map((r) =>
      r.id === runId ? { ...r, resource_keys: ["godot"] } : r,
    ),
  };
  expect(
    finishRun(
      held,
      actor(),
      {
        run_id: runId,
        outcome: "completed",
        summary: "x",
        wait_for: { kind: "resource_available", target_id: "godot" },
      },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  // Only baseline or resource on a delivered producer.
  expect(
    finishRun(
      state,
      actor(),
      {
        run_id: runId,
        outcome: "completed",
        summary: "x",
        wait_for: { kind: "deployment_ready", target_id: next },
      },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    reportBlocker(
      state,
      actor(),
      {
        work_item_id: work,
        reason: "x",
        needs: "role",
        resume_when: { kind: "decision_resolved", target_id: "Q-1" },
      },
      io,
    ),
  ).toMatchObject({ ok: false });
  expect(item().status).toBe("delivered");
  expect(item().standby_wait).toBeUndefined();
});

test("a standby wait is dropped once the item leaves delivered/accepted or is delivered again", () => {
  setItem({ status: "delivered" });
  finish("completed", { kind: "baseline_updated" });
  setItem({ status: "changes_requested" });
  const effect = scan(next);
  expect(effect.data).toEqual([]);
  expect(types(effect)).toContain("work_item_standby_cleared");
  expect(item().standby_wait).toBeUndefined();
});

test("an in-progress resource wait blocks, then resumes in a fresh Run instead of the running one", () => {
  report({ kind: "resource_available", target_id: "godot" });
  expect(item().status).toBe("blocked");
  // The running Run does not hold the resource: never continue it in place.
  expect(scan().data).toEqual([]);
  finish("blocked");
  expect(item().reported_blocker?.auto_registered).toBeUndefined();
  expect(scan().data).toEqual([work]);
  expect(item().status).toBe("in_progress");
  expect(
    state.events.findLast((e) => e.type === "work_item_resume_requested")
      ?.payload,
  ).toMatchObject({
    condition: { kind: "resource_available", target_id: "godot" },
    previous_run_id: runId,
  });
  expect(
    state.events.findLast((e) => e.type === "work_item_resume_requested")
      ?.payload as Record<string, unknown>,
  ).not.toHaveProperty("active_run_id");
});

test("a held card or a Run that already reviewed needs no system registration", () => {
  state = {
    ...state,
    cards: state.cards.map((c) =>
      c.id === id("card", 1)
        ? {
            ...c,
            hold: {
              reason: "Owner paused",
              by: "human",
              at: "2026-01-01T00:00:00.000Z",
            } as never,
          }
        : c,
    ),
  };
  expect(types(finish("blocked"))).toEqual(["run_finished"]);
  expect(item().status).toBe("in_progress");

  state = fixture();
  const reviewer = id("run", 2);
  state = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === id("work_item", 2)
        ? ({ ...w, status: "passed" } as WorkItem)
        : w,
    ),
    reviews: [{ id: "V-1", run_id: reviewer } as never],
  };
  const effect = value(
    finishRun(
      state,
      actor(2, "reviewer"),
      { run_id: reviewer, outcome: "blocked", summary: "Reviewed" },
      io,
    ),
  );
  expect(types(effect)).toEqual(["run_finished"]);
});

test("a blocked verifier Run without anything registered is blocked for PM too", () => {
  state = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === id("work_item", 2)
        ? ({ ...w, status: "in_progress" } as WorkItem)
        : w,
    ),
  };
  const effect = value(
    finishRun(
      state,
      actor(2, "reviewer"),
      { run_id: id("run", 2), outcome: "blocked", summary: "No target yet" },
      io,
    ),
  );
  state = apply(state, effect);
  expect(types(effect)).toEqual(["blocker_reported", "run_finished"]);
  expect(
    state.work_items.find((w) => w.id === id("work_item", 2)),
  ).toMatchObject({
    status: "blocked",
    reported_blocker: { auto_registered: true },
  });
});

test("a standby wake does not spend the allowance of a later rework episode", () => {
  setItem({ status: "delivered" });
  finish("completed", { kind: "resource_available", target_id: "godot" });
  expect(scan().data).toEqual([work]);
  // Rejected: back to work in a fresh Run, without redelivering.
  setItem({ status: "in_progress" });
  state = {
    ...state,
    runs: state.runs.map((r) =>
      r.id === runId ? { ...r, status: "running", outcome: null } : r,
    ),
  };
  report({ kind: "resource_available", target_id: "godot" });
  expect(item()).toMatchObject({ status: "blocked" });
  expect(item().reported_blocker?.auto_resume_disabled).toBeUndefined();
});

test("a repeated standby wait via finish_run is registered for PM, not refused", () => {
  setItem({ status: "accepted" });
  finish("completed", { kind: "baseline_updated" });
  expect(scan(next).data).toEqual([work]);
  state = {
    ...state,
    runs: state.runs.map((r) =>
      r.id === runId ? { ...r, status: "running", outcome: null } : r,
    ),
  };
  const effect = finish("completed", { kind: "baseline_updated" });
  expect(run()).toMatchObject({ status: "completed" });
  expect(item().standby_wait).toMatchObject({ auto_resume_disabled: true });
  expect(effect.events[0]?.payload).toMatchObject({
    auto_resume_disabled: true,
  });
});

test("a satisfied standby wait whose owner was stopped goes to PM once", () => {
  setItem({ status: "accepted" });
  finish("completed", { kind: "baseline_updated" });
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === owner ? { ...a, status: "released" } : a,
    ),
  };
  const first = scan(next);
  expect(first.data).toEqual([]);
  expect(types(first)).toEqual(["work_item_resume_deferred"]);
  expect(types(scan(next))).toEqual([]);
  expect(item().standby_wait).toBeDefined();
});
