import { expect, test } from "vitest";
import {
  type CommandPorts,
  type CommandState,
  createWorkItem,
  prepareDelivery,
  remindSystemWaits,
  setProjectPreferences,
  submitDelivery,
  submitReview,
  updateWorkItem,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  subject,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const atMinute = (minute: number) =>
  new Date(Date.parse(now) + minute * 60_000).toISOString();

async function submitted(io: CommandPorts) {
  let state = fixture();
  state = apply(
    state,
    value(
      setProjectPreferences(
        state,
        human,
        {
          system_reminders: true,
          enable_reviewer_browser: true,
          system_reminder_policy: {
            min_minutes: 1,
            max_minutes: 100,
            min_count: 1,
            max_count: 10,
            unassigned_ready_after_minutes: 2,
            pre_merge_check_pending_after_minutes: 3,
            repeat: false,
            repeat_interval_minutes: null,
            max_reminders: 1,
          },
        },
        io,
      ),
    ),
  );
  const input = {
    work_item_id: id("work_item", 1),
    kind: "code" as const,
    summary: "Ready for review",
    subject,
    requested_verifiers: [id("work_item", 2)],
  };
  const proof = value(
    await prepareDelivery(state, actor(), input, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const delivery = value(submitDelivery(state, actor(), input, proof, io));
  return { state: apply(state, delivery), delivery: delivery.data };
}

function tick(state: CommandState, minute: number, io: CommandPorts) {
  return value(
    remindSystemWaits(state, system, {
      ...io,
      clock: { now: () => atMinute(minute) },
    }),
  );
}

test.each(["producer", "verifier"] as const)(
  "V-831: a downstream item waits from its %s dependency's actual submitReview completion",
  async (dependency) => {
    let minute = 0;
    const io = { ...ports(), clock: { now: () => atMinute(minute) } };
    const submittedWork = await submitted(io);
    let state = submittedWork.state;
    const dependencyId = id("work_item", dependency === "producer" ? 1 : 2);
    const downstream = value(
      createWorkItem(
        state,
        human,
        {
          card_id: id("card", 1),
          title: "Build after review",
          kind: "produce",
          role_id: "coder",
          required: true,
          completion_criteria: ["Build"],
          depends_on: [dependencyId],
        },
        io,
      ),
    );
    state = apply(state, downstream);
    expect(tick(state, 0, io).events).toEqual([]);
    expect(tick(state, 59, io).events).toEqual([]);

    minute = 60;
    const reviewed = value(
      submitReview(
        state,
        actor(2, "reviewer"),
        {
          delivery_id: submittedWork.delivery.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        io,
      ),
    );
    const event = reviewed.events.find((e) => e.type === "review_submitted");
    expect(event?.payload).not.toHaveProperty("work_item_id");
    state = apply(state, reviewed);
    expect(state.work_items.find((w) => w.id === dependencyId)?.status).toBe(
      dependency === "producer" ? "accepted" : "passed",
    );
    const ready = tick(state, 60, io);
    expect(ready.events).toMatchObject([
      {
        type: "system_wait_started",
        payload: { work_item_id: downstream.data.id, since: atMinute(60) },
      },
    ]);
    expect(ready.events).toHaveLength(1);
    state = apply(state, ready);
    expect(tick(state, 62 - 1 / 60_000, io).events).toEqual([]);
    const due = tick(state, 62, io);
    expect(due.events).toMatchObject([
      {
        type: "system_wait_reminded",
        payload: { work_item_id: downstream.data.id, count: 1 },
      },
    ]);
    expect(due.events).toHaveLength(1);
    state = apply(state, due);
    expect(tick(state, 90, io).events).toEqual([]);
  },
);

test.each(["独立复核", "截图核对"])(
  "V-831: clearing a reviewer's manual hold restarts the %s pending threshold",
  async (label) => {
    let minute = 0;
    const io = { ...ports(), clock: { now: () => atMinute(minute) } };
    let { state } = await submitted(io);
    state = {
      ...state,
      cards: state.cards.map((c) =>
        c.id === id("card", 1)
          ? {
              ...c,
              status: "awaiting_merge",
              pre_merge_checks: [
                {
                  label,
                  status: "pending",
                  updated_by: "system",
                  updated_at: now,
                },
              ],
            }
          : c,
      ),
      roles: [...state.roles, role("independent_reviewer")],
      work_items: state.work_items.map((w) =>
        w.id === id("work_item", 2)
          ? { ...w, role_id: "independent_reviewer" }
          : w,
      ),
      assignments: state.assignments.map((a) =>
        a.id === id("assignment", 2)
          ? { ...a, role_id: "independent_reviewer" }
          : a,
      ),
    };
    state = apply(
      state,
      value(
        updateWorkItem(
          state,
          human,
          { work_item_id: id("work_item", 2), manual_assign: true },
          io,
        ),
      ),
    );
    expect(tick(state, 0, io).events).toEqual([]);
    expect(tick(state, 59, io).events).toEqual([]);

    minute = 60;
    state = apply(
      state,
      value(
        updateWorkItem(
          state,
          human,
          { work_item_id: id("work_item", 2), manual_assign: false },
          io,
        ),
      ),
    );
    const resumed = tick(state, 60, io);
    expect(resumed.events).toMatchObject([
      {
        type: "system_wait_started",
        payload: {
          work_item_id: id("work_item", 2),
          label,
          since: atMinute(60),
        },
      },
    ]);
    expect(resumed.events).toHaveLength(1);
    state = apply(state, resumed);
    expect(tick(state, 63 - 1 / 60_000, io).events).toEqual([]);
    const due = tick(state, 63, io);
    expect(due.events).toMatchObject([
      {
        type: "system_wait_reminded",
        payload: { assignment_id: id("assignment", 2), count: 1 },
      },
    ]);
    expect(due.events).toHaveLength(1);
    state = apply(state, due);
    expect(tick(state, 90, io).events).toEqual([]);
  },
);
