import { expect, test } from "vitest";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import {
  assignment,
  human,
  id,
  now,
  ports,
  role,
} from "./commands/test-fixtures.js";
import {
  type Actor,
  type Assignment,
  type CommandState,
  type Event,
  type MergeCheckView,
  notices,
  PM_MERGE_STALL_KIND,
  pmMergeStallAttention,
  projectPreferences,
  recordMergeCheck,
  resolveDelegatedDecision,
  setProjectPreferences,
  standingTools,
} from "./index.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};
const office: Assignment = {
  ...base,
  id: id("assignment", 901),
  scope: "standing",
  standing_mode: "office",
};
const minute = 60_000;
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();

function setup() {
  let clock = now;
  const io = { ...ports(), clock: { now: () => clock } };
  const empty: CommandState = {
    project_id: human.project_id,
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [ops, office],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  const f = mergeFixture("confirm", 3, { state: empty, ports: io });
  const setClock = (ms: number) => {
    clock = at(ms);
  };
  const confirmation = () => {
    const q = f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1);
    if (!q || !("target" in q) || !("delivery_id" in q.target))
      throw new Error("Missing merge confirmation");
    return { ...q, target: q.target };
  };
  const gated = () => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  const check = (
    status: Exclude<MergeCheckView["status"], "executor_unreachable">,
    attempt: string = status,
    resume = false,
  ) => {
    const identity = {
      card_id: f.card.id,
      completion_id: confirmation().target.delivery_id,
      attempt_id: `attempt-${attempt}`,
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
    };
    if (!resume) {
      f.commit(
        recordMergeCheck(
          gated(),
          system,
          { ...identity, status: "queued" },
          io,
        ),
      );
      if (status === "queued") return;
      f.commit(
        recordMergeCheck(
          gated(),
          system,
          { ...identity, status: "running" },
          io,
        ),
      );
      if (status === "running") return;
    }
    f.commit(
      recordMergeCheck(
        gated(),
        system,
        {
          ...identity,
          status,
          summary: status,
          log_ref: `${identity.attempt_id}.log`,
          checks: [
            {
              name: "test",
              status: status === "passed" ? "passed" : "failed",
              exit_code: status === "passed" ? 0 : 1,
              duration_ms: 1,
            },
          ],
        },
        io,
      ),
    );
  };
  const stalls = (
    ms: number,
    options?: Parameters<typeof pmMergeStallAttention>[2],
  ) => pmMergeStallAttention(f.state, at(ms), options);
  return { f, io, setClock, confirmation, check, stalls };
}

test("no alert before the check concludes or within the default 60 minutes; one stable finding after", async () => {
  const { f, check, confirmation, stalls } = setup();
  await f.accept();
  expect(confirmation()).toMatchObject({
    decider: "role:pm",
    status: "open",
  });
  // No check result yet: PM Ops cannot act, so this is not a PM stall.
  expect(stalls(5 * 60 * minute)).toEqual([]);
  check("running", "first");
  expect(stalls(5 * 60 * minute)).toEqual([]);
  check("passed", "first", true);
  expect(stalls(60 * minute)).toEqual([]);
  const later = stalls(60 * minute + 1);
  expect(later).toEqual([
    {
      kind: PM_MERGE_STALL_KIND,
      card_id: f.card.id,
      decision_id: confirmation().id,
      completion_id: confirmation().target.delivery_id,
      since: now,
      waited_ms: 60 * minute + 1,
      threshold_minutes: 60,
      detail: expect.stringContaining(
        `PM 持有的合并确认已停留 60 分钟（${f.card.id}）`,
      ),
    },
  ]);
  // The same wait period keeps the same key, so the host alerts only once.
  expect(stalls(3 * 60 * minute)[0]?.since).toBe(later[0]?.since);
});

test("a concluded check that did not pass also starts the clock", async () => {
  const { f, check, stalls } = setup();
  await f.accept();
  check("failed");
  expect(stalls(61 * minute)).toHaveLength(1);
  expect(stalls(61 * minute)[0]?.card_id).toBe(f.card.id);
});

test("changing the preference uses the new threshold, with an audit event", async () => {
  const { f, io, check, stalls } = setup();
  await f.accept();
  check("passed");
  expect(stalls(31 * minute)).toEqual([]);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { merge_confirm_stall_after_minutes: 30 },
      io,
    ),
  );
  expect(projectPreferences(f.state).merge_confirm_stall_after_minutes).toBe(
    30,
  );
  expect(
    f.state.events
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    {
      old_value: 60,
      new_value: 30,
      preference: "merge_confirm_stall_after_minutes",
    },
  ]);
  expect(stalls(30 * minute)).toEqual([]);
  expect(stalls(30 * minute + 1)).toEqual([
    expect.objectContaining({ threshold_minutes: 30 }),
  ]);
  // Only the human may change it; values outside 1..1440 are rejected.
  expect(
    setProjectPreferences(
      f.state,
      opsActor,
      { merge_confirm_stall_after_minutes: 10 },
      io,
    ).ok,
  ).toBe(false);
  for (const bad of [0, 1441, 1.5])
    expect(
      setProjectPreferences(
        f.state,
        human,
        { merge_confirm_stall_after_minutes: bad },
        io,
      ).ok,
    ).toBe(false);
});

test("a handled confirmation no longer alerts", async () => {
  const { f, io, check, confirmation, stalls } = setup();
  await f.accept();
  check("passed");
  expect(stalls(2 * 60 * minute)).toHaveLength(1);
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "检查通过",
        notice: "常规修复，已合并。",
      },
      io,
    ),
  );
  expect(stalls(2 * 60 * minute)).toEqual([]);
});

test("a later state change of the confirmation restarts the clock", async () => {
  const { f, check, confirmation, setClock, stalls } = setup();
  await f.accept();
  check("passed");
  expect(stalls(61 * minute)).toHaveLength(1);
  // Any event about this decision (e.g. a handoff back and forth) resets it.
  setClock(90 * minute);
  const touched: Event = {
    id: "evt-restart" as Event["id"],
    card_id: f.card.id,
    seq: Math.max(...f.state.events.map((e) => e.seq)) + 1,
    type: "decision_requested",
    actor: system,
    payload: { decision_id: confirmation().id, affected_work_items: [] },
    created_at: at(90 * minute),
  };
  const state = { ...f.state, events: [...f.state.events, touched] };
  expect(pmMergeStallAttention(state, at(149 * minute))).toEqual([]);
  expect(pmMergeStallAttention(state, at(151 * minute))).toEqual([
    expect.objectContaining({ since: at(90 * minute) }),
  ]);
  // A recorded alert does not count as a state change.
  const alerted = {
    ...state,
    events: [
      ...state.events,
      {
        ...touched,
        id: "evt-alert" as Event["id"],
        seq: touched.seq + 1,
        type: PM_MERGE_STALL_KIND,
        created_at: at(151 * minute),
      },
    ],
  };
  expect(pmMergeStallAttention(alerted, at(152 * minute))).toEqual([
    expect.objectContaining({ since: at(90 * minute) }),
  ]);
});

test("human-held confirmations are out of scope", async () => {
  const { f, check, confirmation } = setup();
  await f.accept();
  check("passed");
  const state = {
    ...f.state,
    decisions: f.state.decisions.map((q) =>
      q.id === confirmation().id ? { ...q, decider: "human" as const } : q,
    ),
  };
  expect(pmMergeStallAttention(state, at(5 * 60 * minute))).toEqual([]);
});

test("the suppression extension point (for explicit holds) silences the alert", async () => {
  const { f, check, confirmation, stalls } = setup();
  await f.accept();
  check("passed");
  expect(stalls(2 * 60 * minute, { suppressed: () => false })).toHaveLength(1);
  const seen: string[] = [];
  expect(
    stalls(2 * 60 * minute, {
      suppressed: (q, t) => {
        seen.push(`${q.id}@${t}`);
        return true;
      },
    }),
  ).toEqual([]);
  expect(seen).toEqual([`${confirmation().id}@${at(2 * 60 * minute)}`]);
});

test("a system stall event becomes a Needs You notice for the human", async () => {
  const { f, check, confirmation } = setup();
  await f.accept();
  check("passed");
  const [finding] = pmMergeStallAttention(f.state, at(61 * minute));
  if (!finding) throw new Error("Missing finding");
  const event: Event = {
    id: "evt-stall" as Event["id"],
    card_id: f.card.id,
    seq: Math.max(...f.state.events.map((e) => e.seq)) + 1,
    type: PM_MERGE_STALL_KIND,
    actor: system,
    payload: { ...finding, notice: "PM 持有的合并确认已停留 61 分钟（C-1）" },
    created_at: at(61 * minute),
  };
  const list = notices({ ...f.state, events: [...f.state.events, event] });
  expect(list[0]).toMatchObject({
    id: event.id,
    kind: "merge",
    decision_id: confirmation().id,
    option: "stalled",
    resolved_by: "system",
    body: "PM 持有的合并确认已停留 61 分钟（C-1）",
    read: false,
  });
  // Only the host may raise it.
  expect(
    notices({
      ...f.state,
      events: [...f.state.events, { ...event, actor: human }],
    }).some((n) => n.id === event.id),
  ).toBe(false);
});
