// C-154: pausing a standing PM must not let a merge confirmation it hands to
// the human be auto-merged at once; restarting a standing PM must not hand
// anything over; sensitive cards are never auto-merged on any path.
import { expect, test } from "vitest";
import { HOST_OPS_ROLE_TOOLS } from "../host-ops.js";
import {
  type Actor,
  type Assignment,
  autoConfirmMerge,
  autoMergeSchedule,
  type CommandState,
  type DecisionCategory,
  listNeedsYou,
  pauseStandingAssignment,
  queueRun,
  releaseAssignment,
  requestDecision,
  resolveDelegatedDecision,
  setCardSensitive,
  setProjectPreferences,
  standingTools,
} from "../index.js";
import { CommandDraft } from "./core.js";
import {
  beginHostOpsAction,
  finishHostOpsAction,
  hostOpsExitConfirmation,
  requestHostOpsExitConfirmation,
} from "./host-ops-actions.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { restartStandingSession } from "./standing.js";
import {
  assignment,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const { work_item_id: _w, ...pmBase } = assignment(900, "pm");
const ops: Assignment = {
  ...pmBase,
  scope: "standing",
  standing_mode: "ops",
  runtime_ref: {
    machine_id: "local",
    session_name: "cardigan",
    agent_name: "pm-ops",
    terminal_ref: "pm-ops-terminal",
  } as never,
};
const { work_item_id: _h, ...hostBase } = assignment(910, "host_ops");
const hostOps: Assignment = { ...hostBase, scope: "standing" };
const hostOpsActor = {
  kind: "assignment" as const,
  project_id: human.project_id,
  assignment_id: hostOps.id,
  ...role("host_ops"),
  allowed_tools: HOST_OPS_ROLE_TOOLS,
};
const snapshot = { model: "test", agent_cli_version: "test" };
const at = (f: { io: ReturnType<typeof ports> }, minutes: number) => ({
  ...f.io,
  clock: {
    now: () => new Date(Date.parse(now) + minutes * 60_000).toISOString(),
  },
});

async function setup(pm: Partial<Assignment> = {}, withOps = true) {
  const empty: CommandState = {
    project_id: human.project_id,
    roles: [
      role("coder"),
      role("reviewer"),
      role("pm"),
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
    cards: [],
    work_items: [],
    assignments: withOps
      ? [{ ...ops, ...pm } as Assignment, hostOps]
      : [hostOps],
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
  const f = mergeFixture("confirm", 3, { state: empty, ports: ports() });
  await f.accept();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 5 },
      f.io,
    ),
  );
  const confirmation = () => {
    const q = f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1);
    if (!q) throw new Error("Missing merge confirmation");
    return q;
  };
  expect(confirmation().decider).toBe(withOps ? "role:pm" : "human");
  return { f, confirmation };
}

type Fixture = Awaited<ReturnType<typeof setup>>["f"];
const pause = (f: Fixture, minutes: number) =>
  f.commit(
    pauseStandingAssignment(
      f.state,
      human,
      { assignment_id: ops.id },
      at(f, minutes),
    ),
  );
function hostRestart(f: Fixture, minutes: number) {
  const begun = value(
    beginHostOpsAction(
      f.state,
      hostOpsActor,
      {
        tool: "host_ops_restart_standing_pm",
        target_id: ops.id,
        reason: "PM Ops 失联，重开会话",
        snapshot,
      },
      at(f, minutes),
    ),
  );
  f.commit({ ok: true, value: begun });
  return f.commit(
    finishHostOpsAction(f.state, system, begun.data.action_id, at(f, minutes)),
  );
}

test("C-154: a confirmation handed over by a PM pause gets a full window from the handoff", async () => {
  const { f, confirmation } = await setup();
  // The PM held it for 20 minutes, far past the 5-minute preference.
  pause(f, 20);
  expect(confirmation().decider).toBe("human");
  const schedule = value(autoMergeSchedule(f.state, confirmation().id));
  expect(schedule.waiting_since).toBe("2026-01-01T00:20:00.000Z");
  expect(schedule.due_at).toBe("2026-01-01T00:25:00.000Z");
  const p = { decision_id: confirmation().id };
  // Seconds after the handoff: still waiting for the human.
  expect(autoConfirmMerge(f.state, system, p, at(f, 20.05)).ok).toBe(false);
  expect(autoConfirmMerge(f.state, system, p, at(f, 24.99)).ok).toBe(false);
  // Needs You says where it came from.
  const view = value(listNeedsYou(f.state, human, at(f, 21).clock)).data;
  expect(view.decisions.find((q) => q.id === confirmation().id)).toMatchObject({
    handed_over_from_pm: {
      at: "2026-01-01T00:20:00.000Z",
      reason: expect.stringContaining("已暂停"),
    },
  });
  // A full window later the preference applies as for any confirmation.
  f.commit(autoConfirmMerge(f.state, system, p, at(f, 25)));
  expect(confirmation().resolution).toMatchObject({
    option: "merge",
    resolved_by: "system",
  });
});

test("C-154: a confirmation the human was asked directly keeps its original start and no PM label", async () => {
  const { f, confirmation } = await setup();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: false },
      f.io,
    ),
  );
  expect(value(autoMergeSchedule(f.state, confirmation().id)).due_at).toBe(
    "2026-01-01T00:05:00.000Z",
  );
  const view = value(listNeedsYou(f.state, human, f.io.clock)).data;
  // Withdrawn delegation also came from the PM queue, so it is labelled.
  expect(
    view.decisions.find((q) => q.id === confirmation().id)?.handed_over_from_pm,
  ).not.toBeNull();
});

const RISKS = [
  "sensitive_flag",
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
] as const;
const PATHS = [
  "pause",
  "pause_twice",
  "release",
  "host_restart",
  "delegation_off",
] as const;
function markRisk(f: Fixture, risk: (typeof RISKS)[number], minutes: number) {
  if (risk === "sensitive_flag")
    f.commit(
      setCardSensitive(
        f.state,
        human,
        { card_id: f.card.id, sensitive: true },
        at(f, minutes),
      ),
    );
  else
    f.commit(
      requestDecision(
        f.state,
        human,
        {
          card_id: f.card.id,
          category: risk as DecisionCategory,
          kind: "choose",
          question: "高风险事项？",
          context: "背景",
          options: [{ key: "yes", description: "处理", impact: "影响" }],
          recommended: "yes",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
        },
        at(f, minutes),
      ),
    );
}
function takePath(f: Fixture, path: (typeof PATHS)[number], minutes: number) {
  if (path === "pause") pause(f, minutes);
  else if (path === "pause_twice") {
    pause(f, minutes);
    pause(f, minutes + 1);
  } else if (path === "host_restart") hostRestart(f, minutes);
  else if (path === "release")
    f.commit(
      releaseAssignment(
        f.state,
        human,
        { assignment_id: ops.id },
        at(f, minutes),
      ),
    );
  else
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { pm_merge_confirmation: false },
        at(f, minutes),
      ),
    );
}

test.each(
  RISKS.flatMap((risk) =>
    PATHS.flatMap((path) =>
      (["risk_first", "path_first"] as const).map(
        (order) => [risk, path, order] as const,
      ),
    ),
  ),
)(
  "C-154: a %s card is never auto-merged via %s (%s)",
  async (risk, path, order) => {
    const { f, confirmation } = await setup();
    if (order === "risk_first") {
      markRisk(f, risk, 1);
      takePath(f, path, 2);
    } else {
      takePath(f, path, 1);
      markRisk(f, risk, 2);
    }
    expect(confirmation().decider).toBe("human");
    expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
    expect(
      autoConfirmMerge(
        f.state,
        system,
        { decision_id: confirmation().id },
        at(f, 24 * 60),
      ).ok,
    ).toBe(false);
    expect(confirmation().status).toBe("open");
  },
);

test.each(RISKS)(
  "C-154: a %s card asked of the human directly (no PM Ops) is never auto-merged",
  async (risk) => {
    const { f, confirmation } = await setup({}, false);
    markRisk(f, risk, 1);
    expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
    expect(
      autoConfirmMerge(
        f.state,
        system,
        { decision_id: confirmation().id },
        at(f, 24 * 60),
      ).ok,
    ).toBe(false);
  },
);

test.each([...PATHS, "none"] as const)(
  "C-154: a confirmation the PM escalated to the human stays human-only via %s",
  async (path) => {
    const { f, confirmation } = await setup();
    const pmOps = {
      kind: "assignment" as const,
      project_id: human.project_id,
      assignment_id: ops.id,
      ...role("pm"),
      allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
    };
    f.commit(
      resolveDelegatedDecision(
        f.state,
        pmOps,
        {
          decision_id: confirmation().id,
          option: "merge",
          rationale: "需要人亲自确认",
          notice: "已交给你",
          escalate: true,
        },
        at(f, 1),
      ),
    );
    const reason = confirmation().human_required_reason;
    expect(reason).toBeTruthy();
    if (path !== "none") takePath(f, path, 20);
    expect(confirmation()).toMatchObject({
      decider: "human",
      status: "open",
      human_required_reason: reason,
    });
    expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
    expect(
      autoConfirmMerge(
        f.state,
        system,
        { decision_id: confirmation().id },
        at(f, 24 * 60),
      ).ok,
    ).toBe(false);
  },
);

test("C-154: a restart is refused when the session it stopped is no longer current", async () => {
  const { f, confirmation } = await setup();
  const before = JSON.stringify(f.state);
  const restart = (expected_runtime_ref: Assignment["runtime_ref"]) =>
    queueRun(
      f.state,
      human,
      {
        ...snapshot,
        assignment_id: ops.id,
        restart_session: true,
        expected_runtime_ref,
      },
      at(f, 5),
    );
  const stale = restart({ ...ops.runtime_ref, terminal_ref: "other" } as never);
  expect(stale.ok ? undefined : stale.error.code).toBe("stale_target");
  expect(restart(null).ok).toBe(false);
  expect(JSON.stringify(f.state)).toBe(before);
  f.commit(restart(ops.runtime_ref));
  expect(confirmation().decider).toBe("role:pm");
});

test.each(["idle", "lost", "unknown"] as const)(
  "C-154: host_ops restart of an active PM (%s) keeps every item with the same Assignment",
  async (runtime_state) => {
    const { f, confirmation } = await setup({ runtime_state });
    const before = confirmation();
    const decisionEvents = f.state.events.filter(
      (e) => e.type === "decision_requested",
    ).length;
    const settled = hostRestart(f, 20);
    expect(confirmation()).toEqual(before);
    expect(
      f.state.events.filter((e) => e.type === "decision_requested"),
    ).toHaveLength(decisionEvents);
    expect(f.state.events.some((e) => e.type === "assignment_paused")).toBe(
      false,
    );
    expect(
      f.state.events.filter((e) => e.type === "standing_session_restarted"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ assignment_id: ops.id }),
      }),
    ]);
    expect(f.state.assignments.find((a) => a.id === ops.id)).toMatchObject({
      status: "active",
      runtime_ref: null,
    });
    expect(
      f.state.assignments.find((a) => a.id === ops.id)?.session_ref,
    ).toBeUndefined();
    expect(settled.run).toMatchObject({
      status: "queued",
      assignment_id: ops.id,
    });
    // Still PM work: nothing for the human, nothing to auto-merge.
    expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
    expect(
      value(listNeedsYou(f.state, human, at(f, 30).clock)).data.decisions.map(
        (q) => q.id,
      ),
    ).not.toContain(confirmation().id);
  },
);

test("C-154 × C-152: settling a restart that closes its exit confirmation still keeps PM items in place", async () => {
  const { f, confirmation } = await setup();
  const before = confirmation();
  const begun = value(
    beginHostOpsAction(
      f.state,
      hostOpsActor,
      {
        tool: "host_ops_restart_standing_pm",
        target_id: ops.id,
        reason: "跨运行时终端，人确认退出后重启",
        snapshot,
      },
      at(f, 10),
    ),
  );
  f.commit({ ok: true, value: begun });
  const asked = f.commit(
    requestHostOpsExitConfirmation(
      f.state,
      system,
      {
        action_id: begun.data.action_id,
        instructions: "1. 查看终端\n2. 结束进程\n3. 确认已退出",
        why_human: "终端属于另一个运行时",
      },
      at(f, 11),
    ),
  );
  expect(hostOpsExitConfirmation(f.state, begun.data.action_id).status).toBe(
    "open",
  );
  // The settlement closes the exit confirmation (a human_actions write) and
  // restarts the PM in the same draft; only the restart's own effect counts.
  const settled = f.commit(
    finishHostOpsAction(f.state, system, begun.data.action_id, at(f, 12)),
  );
  expect(settled.run).toMatchObject({
    status: "queued",
    assignment_id: ops.id,
  });
  expect(
    f.state.human_actions.find((h) => h.id === asked.human_action_id)?.status,
  ).toBe("cancelled");
  expect(confirmation()).toEqual(before);
  expect(
    f.state.events.filter((e) => e.type === "standing_session_restarted"),
  ).toHaveLength(1);
  expect(f.state.events.some((e) => e.type === "assignment_paused")).toBe(
    false,
  );
});

test.each(["decisions", "human_actions"] as const)(
  "C-154: a restart whose own effect rewrites %s is still refused",
  async (collection) => {
    const { f, confirmation } = await setup();
    const draft = new CommandDraft(f.state, human, "queue_run", at(f, 5));
    // Earlier writes in the same draft (like C-152's settlement) are allowed…
    const put = draft.put.bind(draft) as (c: string, e: unknown) => void;
    // …but if the restart itself touched PM-owned items, it must fail closed.
    (draft as { put: unknown }).put = (c: string, e: unknown) => {
      put(c, e);
      if (c === "assignments")
        put(
          collection,
          collection === "decisions"
            ? { ...confirmation(), decider: "human" }
            : {
                id: "H-77",
                card_id: f.card.id,
                instructions: "x",
                why_human: "x",
                expected_return: "x",
                blocked_work_items: [],
                status: "open",
                triage: "human",
                requested_by: "system",
                created_at: now,
              },
        );
    };
    let thrown: unknown;
    try {
      restartStandingSession(draft, ops.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      error: {
        code: "invariant_violation",
        message: "重开常驻 PM 会话不能转交拍板或待你执行",
      },
    });
  },
);

test("C-154: host_ops restart of a PM the human paused resumes it without a second handoff", async () => {
  const { f, confirmation } = await setup();
  pause(f, 10);
  const handoffs = f.state.events.filter(
    (e) => e.type === "decision_requested",
  ).length;
  hostRestart(f, 12);
  expect(f.state.assignments.find((a) => a.id === ops.id)?.status).toBe(
    "active",
  );
  expect(
    f.state.events.filter((e) => e.type === "decision_requested"),
  ).toHaveLength(handoffs);
  expect(f.state.events.some((e) => e.type === "assignment_resumed")).toBe(
    true,
  );
  // The human still has the full window that started at the pause.
  expect(value(autoMergeSchedule(f.state, confirmation().id)).due_at).toBe(
    "2026-01-01T00:15:00.000Z",
  );
});

test("C-154: the human restart entry reopens the session without pausing or handing over", async () => {
  const { f, confirmation } = await setup();
  const before = confirmation();
  const restart = (state: CommandState, actor: Actor, extra = {}) =>
    queueRun(
      state,
      actor,
      { ...snapshot, assignment_id: ops.id, restart_session: true, ...extra },
      at(f, 30),
    );
  // Only the human (host CLI) may do this, and not together with resume.
  expect(restart(f.state, hostOpsActor).ok).toBe(false);
  expect(restart(f.state, human, { resume: true }).ok).toBe(false);
  const run = f.commit(restart(f.state, human));
  expect(run).toMatchObject({ status: "queued", assignment_id: ops.id });
  expect(confirmation()).toEqual(before);
  expect(
    f.state.events.some((e) =>
      ["assignment_paused", "assignment_resumed"].includes(e.type),
    ),
  ).toBe(false);
  expect(f.state.assignments.find((a) => a.id === ops.id)).toMatchObject({
    status: "active",
    runtime_ref: null,
  });
  // Restarting again cancels the queued Run of the previous restart.
  const again = f.commit(restart(f.state, human));
  expect(again.id).not.toBe(run.id);
  expect(f.state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
    summary: "Standing PM session restarted by human",
  });
  // A paused PM is resumed with `pm start`, not restarted.
  pause(f, 40);
  expect(restart(f.state, human).ok).toBe(false);
  // Work-item Assignments have no standing session to restart.
  expect(
    queueRun(
      f.state,
      human,
      {
        ...snapshot,
        assignment_id: f.coder.id,
        restart_session: true,
      },
      at(f, 41),
    ).ok,
  ).toBe(false);
});

test("C-154: the restart refuses to run while a host operation is pending", async () => {
  const { f } = await setup();
  f.commit(
    beginHostOpsAction(
      f.state,
      hostOpsActor,
      {
        tool: "host_ops_restart_standing_pm",
        target_id: ops.id,
        reason: "pending",
        snapshot,
      },
      at(f, 1),
    ),
  );
  expect(
    queueRun(
      f.state,
      human,
      { ...snapshot, assignment_id: ops.id, restart_session: true },
      at(f, 2),
    ).ok,
  ).toBe(false);
  expect(id("assignment", 900)).toBe(ops.id);
});
