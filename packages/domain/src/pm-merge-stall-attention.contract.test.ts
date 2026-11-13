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
  autoConfirmMerge,
  autoMergeSchedule,
  type CommandState,
  type Event,
  expireMergeSnoozes,
  listNeedsYou,
  type MergeCheckView,
  mergeConfirmationSnoozed,
  mergeConfirmSnoozeMaxMinutes,
  mergePlan,
  notices,
  PM_MERGE_STALL_KIND,
  pmMergeStallAttention,
  prepareMergePlan,
  projectPreferences,
  recordDecision,
  recordMergeCheck,
  resolveDelegatedDecision,
  setCardSensitive,
  setProjectPreferences,
  standingTools,
} from "./index.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

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

test("C-180: required reason, default expiry, suppression and one durable reopening with a fresh stall clock", async () => {
  const { f, io, check, confirmation, setClock, stalls } = setup();
  await f.accept();
  check("passed");
  const params = {
    decision_id: confirmation().id,
    option: "hold",
    rationale: "等待核对",
  };
  expect(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      { ...params, rationale: "  " },
      io,
    ).ok,
  ).toBe(false);
  for (const bad of ["", now, "garbage", "2035-01-01T12:00:00"])
    expect(
      resolveDelegatedDecision(
        f.state,
        opsActor,
        { ...params, snooze_until: bad },
        io,
      ).ok,
    ).toBe(false);
  setClock(65 * minute);
  f.commit(resolveDelegatedDecision(f.state, opsActor, params, io));
  expect(confirmation()).toMatchObject({
    status: "snoozed",
    decider: "role:pm",
    snooze: { reason: "等待核对", until: at(305 * minute) },
  });
  expect(confirmation().resolution).toBeUndefined();
  expect(mergeConfirmationSnoozed(confirmation(), at(304 * minute))).toBe(true);
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(prepareMergePlan(f.state, f.card.id).ok).toBe(true);
  expect(stalls(304 * minute)).toEqual([]);
  const queue = listNeedsYou(f.state, opsActor);
  if (!queue.ok) throw new Error(queue.error.message);
  expect(queue.value.data.pm_queue?.decisions).toEqual([]);
  expect(queue.value.data.pm_queue?.snoozed_merges).toHaveLength(1);
  setClock(305 * minute);
  expect(expireMergeSnoozes(f.state, opsActor, io).ok).toBe(false);
  f.commit(expireMergeSnoozes(f.state, system, io));
  expect(confirmation()).toMatchObject({ status: "open", decider: "role:pm" });
  expect(confirmation().snooze).toBeUndefined();
  const expired = f.state.timeline.filter((e) => e.body.includes("暂缓已到期"));
  expect(expired).toHaveLength(1);
  expect(expired[0]?.body).toBe(`暂缓已到期：等待核对（${f.card.id}）`);
  f.commit(expireMergeSnoozes(f.state, system, io));
  expect(
    f.state.timeline.filter((e) => e.body.includes("暂缓已到期")),
  ).toHaveLength(1);
  const resumed = listNeedsYou(f.state, opsActor);
  if (!resumed.ok) throw new Error(resumed.error.message);
  expect(resumed.value.data.pm_queue?.expired_snoozes).toEqual([
    expect.objectContaining({ body: expired[0]?.body }),
  ]);
  expect(stalls(365 * minute)).toEqual([]);
  expect(stalls(365 * minute + 1)).toEqual([
    expect.objectContaining({ since: at(305 * minute) }),
  ]);
});

test("C-180: human-only audited preference changes the next hold; an explicit expiry wins", async () => {
  const { f, io, confirmation, setClock } = setup();
  await f.accept();
  const params = { merge_confirm_snooze_default_minutes: 30 };
  expect(setProjectPreferences(f.state, opsActor, params, io).ok).toBe(false);
  for (const bad of [0, 1441, 1.5, NaN])
    expect(
      setProjectPreferences(
        f.state,
        human,
        { merge_confirm_snooze_default_minutes: bad },
        io,
      ).ok,
    ).toBe(false);
  f.commit(setProjectPreferences(f.state, human, params, io));
  f.commit(setProjectPreferences(f.state, human, params, io));
  expect(
    f.state.events
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    {
      preference: "merge_confirm_snooze_default_minutes",
      old_value: 240,
      new_value: 30,
    },
  ]);
  const hold = {
    decision_id: confirmation().id,
    option: "hold",
    rationale: "等待",
    raw_quote: "等待",
  };
  f.commit(recordDecision(f.state, human, hold, io));
  expect(confirmation()).toMatchObject({
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    status: "snoozed",
    snooze: { until: at(30 * minute) },
  });
  expect(resolveDelegatedDecision(f.state, opsActor, hold, io).ok).toBe(false);
  setClock(10 * minute);
  f.commit(
    recordDecision(
      f.state,
      human,
      { ...hold, snooze_until: at(50 * minute) },
      io,
    ),
  );
  expect(confirmation().snooze?.until).toBe(at(50 * minute));
});

test("C-193: the snooze cap defaults to 72 hours and only humans may change it with audit", async () => {
  const { f, io } = setup();
  await f.accept();
  expect(mergeConfirmSnoozeMaxMinutes(projectPreferences(f.state))).toBe(4320);
  for (const actor of [opsActor, system])
    expect(
      setProjectPreferences(
        f.state,
        actor,
        { merge_confirm_snooze_max_minutes: 60 },
        io,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/^(unauthorized|forbidden_tool)$/) },
    });
  for (const bad of [59, 10081, 60.5, NaN, Infinity])
    expect(
      setProjectPreferences(
        f.state,
        human,
        { merge_confirm_snooze_max_minutes: bad },
        io,
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  for (const minutes of [60, 60, 10080])
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { merge_confirm_snooze_max_minutes: minutes },
        io,
      ),
    );
  expect(
    f.state.events.filter((e) => e.type === "project_preferences_updated"),
  ).toMatchObject([
    {
      actor: human,
      payload: {
        preference: "merge_confirm_snooze_max_minutes",
        old_value: 4320,
        new_value: 60,
      },
    },
    {
      actor: human,
      payload: {
        preference: "merge_confirm_snooze_max_minutes",
        old_value: 60,
        new_value: 10080,
      },
    },
  ]);
  expect(mergeConfirmSnoozeMaxMinutes(projectPreferences(f.state))).toBe(10080);
});

test.each(["human", "pm"] as const)(
  "C-193: %s holds accept the exact cap and reject a millisecond beyond it",
  async (caller) => {
    const { f, io, confirmation, setClock } = setup();
    await f.accept();
    setClock(10 * minute);
    const hold = (until: string) => {
      const params = {
        decision_id: confirmation().id,
        option: "hold",
        rationale: "等待",
        raw_quote: "等待",
        snooze_until: until,
      };
      return caller === "human"
        ? recordDecision(f.state, human, params, io)
        : resolveDelegatedDecision(f.state, opsActor, params, io);
    };
    const before = JSON.stringify(f.state);
    expect(hold(at(4330 * minute + 1))).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: expect.stringContaining("4320 分钟"),
      },
    });
    expect(JSON.stringify(f.state)).toBe(before);
    f.commit(hold(at(4330 * minute)));
    expect(confirmation().snooze?.until).toBe(at(4330 * minute));
  },
);

test.each(["human", "pm"] as const)(
  "C-193: %s renewal keeps the first hold's cap across expiry and snapshot reload",
  async (caller) => {
    const { f, io, confirmation, setClock } = setup();
    await f.accept();
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        {
          merge_confirm_snooze_max_minutes: 60,
          merge_confirm_snooze_default_minutes: 30,
        },
        io,
      ),
    );
    const hold = (until?: string) => {
      const params = {
        decision_id: confirmation().id,
        option: "hold",
        rationale: "等待",
        raw_quote: "等待",
        ...(until ? { snooze_until: until } : {}),
      };
      // A freshly loaded snapshot carries persisted events, not in-memory timers.
      const state = JSON.parse(JSON.stringify(f.state)) as CommandState;
      return caller === "human"
        ? recordDecision(state, human, params, io)
        : resolveDelegatedDecision(state, opsActor, params, io);
    };
    setClock(10 * minute);
    f.commit(hold());
    expect(confirmation().snooze?.until).toBe(at(40 * minute));
    setClock(20 * minute);
    f.commit(hold());
    expect(confirmation().snooze?.until).toBe(at(50 * minute));
    setClock(50 * minute);
    f.commit(expireMergeSnoozes(f.state, system, io));
    expect(confirmation().snooze).toBeUndefined();
    const before = JSON.stringify(f.state);
    for (const until of [undefined, at(70 * minute + 1)])
      expect(hold(until)).toMatchObject({
        ok: false,
        error: {
          code: "validation_failed",
          message: expect.stringContaining("暂缓累计时长不能超过 60 分钟"),
        },
      });
    expect(JSON.stringify(f.state)).toBe(before);
    f.commit(hold(at(70 * minute)));
    setClock(70 * minute);
    f.commit(expireMergeSnoozes(f.state, system, io));
    expect(hold(at(70 * minute + 1))).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("已达上限请交人或处理合并确认"),
      },
    });
  },
);

test("C-193: a new cap applies to the next hold without clamping the configured default or rewriting an existing hold", async () => {
  const { f, io, confirmation } = setup();
  await f.accept();
  const params = {
    decision_id: confirmation().id,
    option: "hold",
    rationale: "等待",
    raw_quote: "等待",
  };
  f.commit(recordDecision(f.state, human, params, io));
  const held = confirmation();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { merge_confirm_snooze_max_minutes: 60 },
      io,
    ),
  );
  expect(confirmation()).toEqual(held);
  expect(recordDecision(f.state, human, params, io)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("距现在不能超过 60 分钟") },
  });
  f.commit(
    recordDecision(
      f.state,
      human,
      { ...params, snooze_until: at(60 * minute) },
      io,
    ),
  );
  expect(confirmation().snooze?.until).toBe(at(60 * minute));
});

test("C-180: sensitivity and delegation handoffs retain the hold and human authority at expiry", async () => {
  const { f, io, confirmation, setClock } = setup();
  await f.accept();
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      { decision_id: confirmation().id, option: "hold", rationale: "等待" },
      io,
    ),
  );
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      io,
    ),
  );
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 1, pm_merge_confirmation: false },
      io,
    ),
  );
  expect(confirmation()).toMatchObject({ status: "snoozed", decider: "human" });
  expect(f.state.cards.find((c) => c.id === f.card.id)?.sensitive).toBe(true);
  expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
  setClock(240 * minute);
  f.commit(expireMergeSnoozes(f.state, system, io));
  expect(confirmation()).toMatchObject({ status: "open", decider: "human" });
  setClock(300 * minute);
  expect(
    autoConfirmMerge(f.state, system, { decision_id: confirmation().id }, io)
      .ok,
  ).toBe(false);
});

test("C-180: returning a snoozed confirmation invalidates it; expiry cannot revive it", async () => {
  const { f, io, confirmation, setClock } = setup();
  await f.accept();
  const held = confirmation().id;
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      { decision_id: held, option: "hold", rationale: "等待" },
      io,
    ),
  );
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      { decision_id: held, option: "request_changes", rationale: "需要修复" },
      io,
    ),
  );
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
    "in_progress",
  );
  setClock(300 * minute);
  expect(f.commit(expireMergeSnoozes(f.state, system, io))).toEqual([]);
  expect(f.state.decisions.find((q) => q.id === held)?.status).not.toBe("open");
});
