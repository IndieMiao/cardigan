import { beforeEach, expect, test } from "vitest";
import type { Event, WorkItem } from "../entities.js";
import { command } from "./core.js";
import {
  claimInactiveRunStop,
  DEFAULT_INACTIVE_CANCEL_AFTER_MS,
  finishInactiveRunStop,
  startInactiveRunStop,
} from "./inactive-run.js";
import {
  actor,
  commit,
  dispatch,
  f,
  item,
  queue,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { acknowledgeRun } from "./launch.js";
import {
  SESSION_ROTATION_REQUESTED,
  SESSION_ROTATION_SKIPPED,
  settleSessionRotation,
} from "./session-rotation.js";

/**
 * C-789 contract (§4.5 inv. 5, 6, 10): a stuck session is rerun only after
 * the host proved its exact terminal exited, at most once per Assignment, and
 * only for in-progress, unblocked work with something unread. Otherwise the
 * rotation is recorded and, once spent, goes to PM: no wake → idle → wait
 * 60 minutes → wake loop.
 */
let now = 0;
beforeEach(() => {
  setup();
  now = Date.parse(f.io.clock.now());
  f.io = { ...f.io, clock: { now: () => new Date(now).toISOString() } };
});

function setItem(patch: Partial<WorkItem>) {
  f.state = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === f.coder.work_item_id ? ({ ...w, ...patch } as WorkItem) : w,
    ),
  };
}
function humanComment() {
  const card = item().card_id;
  const seq = Math.max(0, ...f.state.events.map((e) => e.seq)) + 1;
  const e: Event = {
    id: f.io.ids.nextEventId(),
    seq,
    card_id: card,
    type: "comment_posted",
    actor: { kind: "human", project_id: f.state.project_id },
    payload: { body: "Please also cover the empty case" },
    created_at: f.io.clock.now(),
  };
  f.state = { ...f.state, events: [...f.state.events, e] };
}
/** One running Run, silent past the grace, stopped with proven exit. */
function stopSilentRun() {
  const run = commit(queue());
  commit(dispatch(run));
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  setItem({ status: "in_progress" });
  now += DEFAULT_INACTIVE_CANCEL_AFTER_MS;
  const after_ms = DEFAULT_INACTIVE_CANCEL_AFTER_MS;
  const claimed = commit(
    claimInactiveRunStop(f.state, system, { run_id: run.id, after_ms }, f.io),
  );
  const stop = claimed?.inactivity_stop;
  if (!stop) throw new Error("Missing stop intent");
  commit(
    startInactiveRunStop(
      f.state,
      system,
      { run_id: run.id, attempt_id: stop.attempt_id, after_ms },
      f.io,
    ),
  );
  const before = f.state.events.length;
  commit(
    finishInactiveRunStop(
      f.state,
      system,
      {
        run_id: run.id,
        attempt_id: stop.attempt_id,
        runtime_ref: stop.runtime_ref,
        exited: true,
      },
      f.io,
    ),
  );
  return { run, events: f.state.events.slice(before) };
}
/** The owner read everything so far (its Run's protocol ack). */
function ackAll() {
  f.state = {
    ...f.state,
    cursors: [
      {
        assignment_id: f.coder.id,
        card_id: item().card_id,
        acked_seq: Math.max(0, ...f.state.events.map((e) => e.seq)),
      },
    ],
  };
}
const ofType = (events: readonly Event[], type: string) =>
  events.filter((e) => e.type === type);

test("proven exit with unread in-progress work reruns once; the next stall goes to PM", () => {
  ackAll();
  humanComment();
  const first = stopSilentRun();
  expect(first.events.map((e) => e.type).slice(-3)).toEqual([
    "run_inactivity_stop_finished",
    SESSION_ROTATION_REQUESTED,
    "work_item_resume_requested",
  ]);
  first.events.splice(0, first.events.length - 3);
  expect(first.events[1]).toMatchObject({
    actor: system,
    payload: {
      assignment_id: f.coder.id,
      signal: "inactive",
      run_id: first.run.id,
    },
  });
  expect(first.events[2]).toMatchObject({
    actor: system,
    payload: {
      work_item_id: f.coder.work_item_id,
      assignment_id: f.coder.id,
      rotation: true,
      previous_run_id: first.run.id,
    },
  });
  // The rotation does not consume a wait allowance.
  expect(first.events[2]?.payload).not.toHaveProperty("automatic_wait");
  expect(item().status).toBe("in_progress");

  // The new session goes silent again with new unread work: no second wake.
  humanComment();
  const second = stopSilentRun();
  expect(ofType(second.events, "work_item_resume_requested")).toEqual([]);
  expect(ofType(second.events, SESSION_ROTATION_SKIPPED)[0]).toMatchObject({
    payload: { reason: "allowance_used", signal: "inactive" },
  });
  expect(ofType(f.state.events, SESSION_ROTATION_REQUESTED)).toHaveLength(1);
});

test("nothing unread: the stop is recorded but nobody is woken (no idle loop)", () => {
  ackAll();
  const { events } = stopSilentRun();
  expect(ofType(events, "work_item_resume_requested")).toEqual([]);
  expect(ofType(events, SESSION_ROTATION_SKIPPED)[0]?.payload).toMatchObject({
    reason: "nothing_unread",
  });
  // The allowance is still available for a real need later.
  expect(ofType(f.state.events, SESSION_ROTATION_REQUESTED)).toEqual([]);
});

test("system telemetry and the owner's own writes are not unread", () => {
  ackAll();
  const card = item().card_id;
  const seq = Math.max(0, ...f.state.events.map((e) => e.seq)) + 1;
  f.state = {
    ...f.state,
    events: [
      ...f.state.events,
      {
        id: f.io.ids.nextEventId(),
        seq,
        card_id: card,
        type: "run_inactive",
        actor: system,
        payload: {},
        created_at: f.io.clock.now(),
      },
      {
        id: f.io.ids.nextEventId(),
        seq: seq + 1,
        card_id: card,
        type: "comment_posted",
        actor: actor(),
        payload: { body: "note to self" },
        created_at: f.io.clock.now(),
      },
    ],
  };
  const { events } = stopSilentRun();
  expect(ofType(events, SESSION_ROTATION_SKIPPED)[0]?.payload).toMatchObject({
    reason: "nothing_unread",
  });
});

test("acked work is not unread", () => {
  humanComment();
  ackAll();
  const { events } = stopSilentRun();
  expect(ofType(events, "work_item_resume_requested")).toEqual([]);
});

test("blocked or waiting work is never rerun", () => {
  humanComment();
  const run = commit(queue());
  commit(dispatch(run));
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  setItem({ status: "blocked" });
  const after_ms = DEFAULT_INACTIVE_CANCEL_AFTER_MS;
  now += after_ms;
  const stop = commit(
    claimInactiveRunStop(f.state, system, { run_id: run.id, after_ms }, f.io),
  )?.inactivity_stop;
  if (!stop) throw new Error("Missing stop intent");
  commit(
    startInactiveRunStop(
      f.state,
      system,
      { run_id: run.id, attempt_id: stop.attempt_id, after_ms },
      f.io,
    ),
  );
  commit(
    finishInactiveRunStop(
      f.state,
      system,
      {
        run_id: run.id,
        attempt_id: stop.attempt_id,
        runtime_ref: stop.runtime_ref,
        exited: true,
      },
      f.io,
    ),
  );
  expect(ofType(f.state.events, "work_item_resume_requested")).toEqual([]);
  expect(
    ofType(f.state.events, SESSION_ROTATION_SKIPPED)[0]?.payload,
  ).toMatchObject({ reason: "not_in_progress" });
});

test("without exit proof, or while a session is still bound, nothing starts", () => {
  humanComment();
  setItem({ status: "in_progress" });
  const owner = () => f.state.assignments.find((a) => a.id === f.coder.id);
  const settle = (proof: Parameters<typeof settleSessionRotation>[4]) =>
    commit(
      command(f.state, system, "manage_inactive_run_stop", f.io, (d) => {
        const a = owner();
        if (!a) throw new Error("Missing assignment");
        return settleSessionRotation(
          d,
          a,
          "retirement_failed",
          undefined,
          proof,
        );
      }),
    );
  expect(settle(undefined)).toBe("no_exit_proof");
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "coder",
    worktree_path: "/fixture/worktree",
    branch: "agent/example",
  };
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, runtime_ref: ref } : a,
    ),
  };
  expect(
    settle({ runtime_ref: ref, exited: true, evidence: "attempt-x" }),
  ).toBe("session_bound");
  expect(ofType(f.state.events, "work_item_resume_requested")).toEqual([]);
  expect(ofType(f.state.events, SESSION_ROTATION_REQUESTED)).toEqual([]);
});

test("a system wake addressed to another work item or Assignment is not unread", () => {
  ackAll();
  const card = item().card_id;
  const seq = Math.max(0, ...f.state.events.map((e) => e.seq)) + 1;
  f.state = {
    ...f.state,
    events: [
      ...f.state.events,
      {
        id: f.io.ids.nextEventId(),
        seq,
        card_id: card,
        type: "work_item_resume_requested",
        actor: system,
        payload: {
          work_item_id: f.reviewer.work_item_id ?? "W-999",
          assignment_id: f.reviewer.id,
        },
        created_at: f.io.clock.now(),
      },
    ],
  };
  const { events } = stopSilentRun();
  expect(ofType(events, SESSION_ROTATION_SKIPPED)[0]?.payload).toMatchObject({
    reason: "nothing_unread",
  });
});
