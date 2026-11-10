import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  type Notification,
  obsoleteDispatchAttention,
  type Run,
  recoverDispatch,
  resolveDispatchAttention,
} from "../index.js";
import { CommandDraft } from "./core.js";
import {
  actor,
  commit,
  dispatch,
  f,
  queue,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { conflictRepairEvent } from "./review-round.js";

let run: Run;
let now: number;
beforeEach(() => {
  setup();
  now = Date.parse(f.io.clock.now());
  f.io = { ...f.io, clock: { now: () => new Date(now).toISOString() } };
  run = commit(dispatch(commit(queue())));
});
const recover = (target = run, failed_attempts = 0) =>
  recoverDispatch(
    f.state,
    system,
    {
      run_id: target.id,
      timeout_ms: 600000,
      failed_attempts,
      max_failures: 5,
      stopped_runtime:
        f.state.assignments.find((a) => a.id === target.assignment_id)
          ?.runtime_ref ?? null,
    },
    f.io,
  );

test("timeout cancels and queues atomically, preserves snapshot and spends the Assignment's only recovery", () => {
  now += 599999;
  expect(commit(recover())).toBeUndefined();
  now++;
  const replacement = commit(recover());
  expect(replacement).toMatchObject({
    status: "queued",
    model: run.model,
    kind: run.kind,
    role_version: run.role_version,
  });
  expect(f.state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(
    f.state.runs.filter(
      (r) => !["cancelled", "completed", "failed"].includes(r.status),
    ),
  ).toHaveLength(1);
  expect(commit(recover())).toBeUndefined();
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  now += 600000;
  expect(commit(recover(replacement))).toBeUndefined();
  expect(f.state.runs).toHaveLength(2);
  expect(f.state.human_actions).toHaveLength(1);
  expect(f.state.human_actions[0]?.instructions).toContain(
    `cardigan assignment stop ${f.coder.id}`,
  );
  expect(f.state.human_actions[0]?.instructions).toContain("10 分钟");
  commit(recover(replacement));
  expect(f.state.human_actions).toHaveLength(1);
});

test("consecutive failure threshold recovers before timeout; a real MCP start wins", () => {
  expect(commit(recover(run, 4))).toBeUndefined();
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  commit(acknowledgeRun(f.state, actor(), { run_id: replacement.id }, f.io));
  now += 600000;
  expect(commit(recover(replacement, 5))).toBeUndefined();
  expect(f.state.human_actions).toEqual([]);
});

test("agents cannot recover Runs and paused/released Assignments never auto-resume", () => {
  expect(
    recoverDispatch(
      f.state,
      actor(),
      { run_id: run.id, timeout_ms: 1, failed_attempts: 5, max_failures: 5 },
      f.io,
    ).ok,
  ).toBe(false);
  for (const status of ["suspended", "released"] as const) {
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === run.assignment_id ? { ...a, status } : a,
      ),
    };
    expect(commit(recover(run, 5))).toBeUndefined();
  }
  expect(f.state.runs).toHaveLength(1);
});

test("automatic cancellation requires proof for the exact current terminal", () => {
  const params = {
    run_id: run.id,
    timeout_ms: 1,
    failed_attempts: 5,
    max_failures: 5,
  };
  expect(recoverDispatch(f.state, system, params, f.io).ok).toBe(false);
  expect(
    recoverDispatch(f.state, system, { ...params, stopped_runtime: null }, f.io)
      .ok,
  ).toBe(false);
  expect(f.state.runs[0]?.status).toBe("dispatched");
});

test("active PM Ops receives the escalation without a human action", () => {
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  const { work_item_id: _workItem, ...standing } = f.coder;
  f.state = {
    ...f.state,
    assignments: [
      ...f.state.assignments,
      {
        ...standing,
        id: "A-999" as never,
        scope: "standing",
        role_id: "pm",
        standing_mode: "ops",
      },
    ],
  };
  commit(recover(replacement, 5));
  expect(f.state.events.at(-1)?.payload).toMatchObject({ audience: "pm_ops" });
  expect(f.state.human_actions).toEqual([]);
});

test("completed Run and released Assignment attention resolves without changing ACK cursors", () => {
  const note: Notification = {
    id: "notice",
    project_id: f.state.project_id,
    event_id: run.trigger_event_id,
    recipient: { kind: "assignment", assignment_id: f.coder.id },
    seq: 1,
    kind: "run_attention",
    status: "needs_attention",
    attempts: 1,
    run_id: run.id,
    created_at: f.io.clock.now(),
    updated_at: f.io.clock.now(),
  };
  expect(obsoleteDispatchAttention(f.state, note)).toBe(false);
  commit(recover(run, 5));
  expect(obsoleteDispatchAttention(f.state, note)).toBe(true);
  expect(f.state.cursors).toEqual([]);
  const missingRun = { ...note, run_id: undefined } as unknown as Notification;
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) => ({ ...a, status: "released" })),
  };
  expect(obsoleteDispatchAttention(f.state, missingRun)).toBe(true);
});

test("late start closes the Needs You action after escalation", () => {
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  commit(recover(replacement, 5));
  expect(f.state.human_actions[0]?.status).toBe("open");
  commit(acknowledgeRun(f.state, actor(), { run_id: replacement.id }, f.io));
  commit(resolveDispatchAttention(f.state, system, f.io));
  expect(f.state.human_actions[0]?.status).toBe("cancelled");
  const count = f.state.events.length;
  commit(resolveDispatchAttention(f.state, system, f.io));
  expect(f.state.events).toHaveLength(count);
});

test("dispatch recovery retains the original conflict fix's review exemption", () => {
  const item = f.state.work_items.find((w) => w.id === f.coder.work_item_id);
  if (!item) throw new Error("Missing item");
  const event = {
    id: f.io.ids.nextEventId(),
    seq: 100,
    card_id: item.card_id,
    type: "merge_conflicted",
    actor: system,
    created_at: f.io.clock.now(),
    payload: { work_item_id: item.id },
  };
  run = { ...run, kind: "fix", trigger_event_id: event.id };
  f.state = { ...f.state, events: [...f.state.events, event], runs: [run] };
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  const draft = new CommandDraft(f.state, system, "recover_dispatch", f.io);
  expect(conflictRepairEvent(draft, item, replacement, false)).toBe(event.id);
});
