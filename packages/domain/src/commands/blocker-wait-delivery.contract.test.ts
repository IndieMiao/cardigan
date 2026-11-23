// C-622: a satisfied, system-verifiable wait no longer strands the author's delivery.
import { beforeEach, expect, test } from "vitest";
import type { Actor, Decision, Event, JsonValue } from "../entities.js";
import type { ResumeCondition } from "../work-wait.js";
import { reportBlocker } from "./coordination.js";
import type { CommandState } from "./core.js";
import { prepareDelivery, submitDelivery } from "./delivery.js";
import { listNeedsYou } from "./queries.js";
import { finishRun } from "./runtime.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  run as makeRun,
  ports,
  subject,
  value,
} from "./test-fixtures.js";
import { resumeWorkWaits } from "./work-waits.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const work = id("work_item", 1),
  owner = id("assignment", 1),
  runId = id("run", 1);
const deployed = "b".repeat(40),
  other = "c".repeat(40);
const params = {
  work_item_id: work,
  kind: "code" as const,
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2)],
};
let io = ports(),
  state = fixture();
beforeEach(() => {
  io = ports();
  state = fixture();
});

function event(
  type: string,
  payload: JsonValue,
  eventActor: Actor = system,
  card_id: Event["card_id"] = undefined,
) {
  const e: Event = {
    id: io.ids.nextEventId(),
    seq: io.ids.nextEventSequence(state.project_id, card_id),
    type,
    payload,
    actor: eventActor,
    ...(card_id ? { card_id } : {}),
    created_at: io.clock.now(),
  };
  state = { ...state, events: [...state.events, e] };
  return e;
}
function block(resume_when?: ResumeCondition) {
  state = apply(
    state,
    value(
      reportBlocker(
        state,
        actor(),
        {
          work_item_id: work,
          reason: "等待平台修复上线",
          needs: "role",
          ...(resume_when ? { resume_when } : {}),
        },
        io,
      ),
    ),
  );
}
function finish() {
  state = apply(
    state,
    value(
      finishRun(
        state,
        actor(),
        { run_id: runId, outcome: "blocked", summary: "Waiting" },
        io,
      ),
    ),
  );
}
function scan() {
  const effect = value(resumeWorkWaits(state, system, {}, io));
  state = apply(state, effect);
  return effect;
}
async function deliver() {
  const receipt = value(
    await prepareDelivery(state, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  return submitDelivery(state, actor(), params, receipt, io);
}
async function delivered() {
  const effect = value(await deliver());
  state = apply(state, effect);
  return effect;
}
const item = () => state.work_items.find((w) => w.id === work);
function pmQueue() {
  const pmState = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "ops" as const } : a,
    ),
  };
  return value(listNeedsYou(pmState, actor(4, "pm"), io.clock)).data.pm_queue
    ?.deferred_resumes;
}
function deploy(to: string, status: string, ready: boolean) {
  event("host_deployment_recorded", {
    from: "a".repeat(40),
    to,
    status,
    ready,
  });
}
const decision = (
  patch: {
    blocking?: boolean;
    affected_work_items?: Decision["affected_work_items"];
  } = {},
): Decision => ({
  id: id("decision", 1),
  kind: "choose",
  key: id("decision", 1),
  doc_refs: [],
  question: "Wait",
  context: "Wait",
  options: [],
  recommended: "",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  status: "open",
  raised_by: "human",
  ...patch,
});
function mergeCard2() {
  state = {
    ...state,
    cards: state.cards.map((c) =>
      c.id === id("card", 2) ? { ...c, status: "done" } : c,
    ),
  };
  event("card_merged", { merge_sha: deployed }, system, id("card", 2));
}
function expectStillBlocked(
  result: Awaited<ReturnType<typeof deliver>>,
  reason?: string,
) {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  if (reason && !result.ok) expect(result.error.message).toContain(reason);
  expect(item()?.status).toBe("blocked");
  expect(item()?.reported_blocker).toBeDefined();
}

test("platform fix: merge alone is not a deployment; after deployment the author's new session delivers and clears the blocker in one step", async () => {
  block({ kind: "deployment_ready", target_id: deployed });
  mergeCard2();
  expectStillBlocked(await deliver(), "尚无系统记录证明已满足");
  deploy(deployed, "stopping", false);
  deploy(deployed, "failed", true);
  expectStillBlocked(await deliver(), "尚无系统记录证明已满足");
  deploy(other, "deployed", true);
  expectStillBlocked(await deliver(), "尚无系统记录证明已满足");
  const ready = event("host_deployment_recorded", {
    from: "a".repeat(40),
    to: deployed,
    status: "deployed",
    ready: true,
  });
  // The author delivers before the background has refreshed the blocker.
  const blockerEvent = state.events.findLast(
    (e) => e.type === "blocker_reported",
  );
  const effect = await delivered();
  expect(effect.events.map((e) => e.type)).toEqual(
    expect.arrayContaining(["blocker_wait_delivered", "delivery_submitted"]),
  );
  const trace = effect.events.find((e) => e.type === "blocker_wait_delivered");
  expect(trace).toMatchObject({
    card_id: id("card", 1),
    actor: { kind: "assignment", assignment_id: owner },
    payload: {
      work_item_id: work,
      assignment_id: owner,
      condition: { kind: "deployment_ready", target_id: deployed },
      evidence: ready.id,
      blocker_event_id: blockerEvent?.id,
      blocker_reported_by: `assignment:${owner}`,
    },
  });
  expect(
    effect.events.findIndex((e) => e.type === "blocker_wait_delivered"),
  ).toBeLessThan(
    effect.events.findIndex((e) => e.type === "delivery_submitted"),
  );
  expect(
    effect.timeline.some((t) => t.body.includes("提交交付时自动解除阻塞")),
  ).toBe(true);
  expect(
    effect.events.some((e) => e.type === "work_item_resume_requested"),
  ).toBe(false);
  expect(effect.events.some((e) => e.type === "run_queued")).toBe(false);
  expect(item()?.reported_blocker).toBeUndefined();
  expect(item()?.status).toBe("delivered");
  expect(effect.data.status).toBe("submitted");
  expect(pmQueue()).toEqual([]);
  // Replayed background ticks after the inline recovery do nothing.
  expect(scan().events).toEqual([]);
  finish();
  expect(scan().events).toEqual([]);
});

test("live author Run: the background clears the satisfied wait in place and notifies that Run once", () => {
  block({ kind: "deployment_ready", target_id: deployed });
  mergeCard2();
  expect(scan().data).toEqual([]);
  deploy(deployed, "deployed", true);
  const blockerEvent = state.events.findLast(
    (e) => e.type === "blocker_reported",
  );
  const effect = scan();
  expect(effect.data).toEqual([work]);
  expect(effect.events.map((e) => e.type)).toEqual([
    "work_item_resume_requested",
    "work_waits_resumed",
  ]);
  expect(effect.events[0]?.payload).toMatchObject({
    work_item_id: work,
    assignment_id: owner,
    active_run_id: runId,
    condition: { kind: "deployment_ready", target_id: deployed },
    blocker_event_id: blockerEvent?.id,
    reported_blocker_cleared: true,
  });
  expect(effect.timeline[0]?.body).toContain(`进行中的 ${runId} 继续`);
  expect(item()).toMatchObject({ status: "in_progress" });
  expect(item()?.reported_blocker).toBeUndefined();
  expect(state.runs.filter((r) => r.assignment_id === owner)).toHaveLength(1);
  expect(pmQueue()).toEqual([]);
  // Replays and the Run's own finish do not resume or wake again.
  expect(scan().events).toEqual([]);
  finish();
  expect(scan().events).toEqual([]);
});

test.each(["hold", "stopping run", "other blocker"])(
  "live author Run: %s still keeps the satisfied wait blocked",
  (guard) => {
    block({ kind: "card_merged", target_id: id("card", 2) });
    mergeCard2();
    if (guard === "hold")
      state = {
        ...state,
        cards: state.cards.map((c) =>
          c.id === id("card", 1)
            ? {
                ...c,
                hold: {
                  reason: "Paused",
                  set_at: io.clock.now(),
                  set_by: "human",
                  resume_condition: "PM resumes",
                },
              }
            : c,
        ),
      };
    if (guard === "stopping run")
      state = {
        ...state,
        runs: state.runs.map((r) =>
          r.id === runId
            ? {
                ...r,
                dispatch_stop: {
                  attempt_id: io.ids.nextEventId(),
                  runtime_ref: null,
                  lease_until: io.clock.now(),
                  stopping: false,
                },
              }
            : r,
        ) as CommandState["runs"],
      };
    if (guard === "other blocker")
      state = {
        ...state,
        decisions: [decision({ blocking: true, affected_work_items: [work] })],
      };
    const effect = scan();
    expect(effect.data).toEqual([]);
    expect(
      effect.events.some((e) => e.type === "work_item_resume_requested"),
    ).toBe(false);
    expect(item()?.status).toBe("blocked");
    expect(item()?.reported_blocker).toBeDefined();
  },
);

const platform = "platform-project";
function platformRecord(
  to: string,
  status: string,
  ready: boolean,
  patch: Partial<Event> = {},
): Event {
  return {
    id: io.ids.nextEventId(),
    seq: io.ids.nextEventSequence(platform, undefined),
    type: "host_deployment_recorded",
    actor: { kind: "system", project_id: platform },
    payload: { from: "a".repeat(40), to, status, ready },
    created_at: io.clock.now(),
    ...patch,
  };
}
function withPlatform(records: readonly Event[]) {
  io = {
    ...io,
    platform_deployments: (project, sha) =>
      records.filter(
        (e) =>
          e.actor.project_id !== project &&
          (e.payload as { to?: string }).to === sha,
      ),
  };
}

test("platform project: only a trusted, ready deployment of the exact SHA settles a business wait", async () => {
  block({ kind: "deployment_ready", target_id: deployed });
  const records: Event[] = [
    // The platform card merged; merge alone is not a deployment.
    {
      ...platformRecord(deployed, "stopping", false),
      type: "card_merged",
      card_id: id("card", 9),
    },
    platformRecord(deployed, "stopping", false),
    platformRecord(deployed, "failed", true),
    platformRecord(other, "deployed", true),
    // Untrusted authors, card streams and this project's own id never count.
    platformRecord(deployed, "deployed", true, {
      actor: { kind: "human", project_id: platform },
    }),
    platformRecord(deployed, "deployed", true, { card_id: id("card", 9) }),
    platformRecord(deployed, "deployed", true, {
      actor: { kind: "system", project_id: state.project_id },
    }),
  ];
  withPlatform(records);
  expect(scan().data).toEqual([]);
  expectStillBlocked(await deliver(), "尚无系统记录证明已满足");
  const ready = platformRecord(deployed, "deployed", true);
  withPlatform([...records, ready]);
  const effect = await delivered();
  expect(
    effect.events.find((e) => e.type === "blocker_wait_delivered")?.payload,
  ).toMatchObject({
    condition: { kind: "deployment_ready", target_id: deployed },
    evidence: `${platform}/${ready.id}`,
  });
  expect(item()?.status).toBe("delivered");
});

test("platform project: a later rollback of the same SHA no longer counts", () => {
  block({ kind: "deployment_ready", target_id: deployed });
  finish();
  const history = [
    platformRecord(deployed, "deployed", true),
    platformRecord(deployed, "rolled_back", false),
  ];
  withPlatform(history);
  expect(scan().data).toEqual([]);
  const ready = platformRecord(deployed, "deployed", true);
  withPlatform([...history, ready]);
  const effect = scan();
  expect(effect.data).toEqual([work]);
  expect(effect.events[0]?.payload).toMatchObject({
    evidence: `${platform}/${ready.id}`,
  });
});

test("upstream precheck of another item: delivery waits for it to finish, then clears inline", async () => {
  const upstream = { card_id: id("card", 2), work_item_id: id("work_item", 9) };
  event(
    "precheck_queued",
    { ...upstream, attempt_id: "upstream", status: "queued" },
    system,
    id("card", 2),
  );
  block({ kind: "precheck_finished", target_id: "upstream" });
  event(
    "precheck_started",
    { ...upstream, attempt_id: "upstream", status: "running" },
    system,
    id("card", 2),
  );
  expectStillBlocked(await deliver(), "尚无系统记录证明已满足");
  event(
    "precheck_finished",
    {
      ...upstream,
      attempt_id: "upstream",
      status: "passed",
      head_sha: deployed,
    },
    system,
    id("card", 2),
  );
  const effect = await delivered();
  expect(
    effect.events.find((e) => e.type === "blocker_wait_delivered")?.payload,
  ).toMatchObject({
    condition: { kind: "precheck_finished", target_id: "upstream" },
  });
  expect(item()?.status).toBe("delivered");
});

test("own precheck wait keeps the same-commit rule", async () => {
  const own = {
    card_id: id("card", 1),
    work_item_id: work,
    assignment_id: owner,
  };
  event(
    "precheck_queued",
    { ...own, attempt_id: "own", status: "queued", head_sha: other },
    system,
    id("card", 1),
  );
  block({ kind: "precheck_finished", target_id: "own" });
  event(
    "precheck_finished",
    { ...own, attempt_id: "own", status: "passed", head_sha: other },
    system,
    id("card", 1),
  );
  expectStillBlocked(await deliver(), "同一提交预检通过");
});

const verifiable: {
  name: string;
  condition: () => ResumeCondition;
  settle: () => void;
}[] = [
  {
    name: "card_merged",
    condition: () => ({ kind: "card_merged", target_id: id("card", 2) }),
    settle: mergeCard2,
  },
  {
    name: "decision_resolved",
    condition: () => {
      state = { ...state, decisions: [decision()] };
      return { kind: "decision_resolved", target_id: id("decision", 1) };
    },
    settle: () => {
      state = {
        ...state,
        decisions: state.decisions.map((q) => ({
          ...q,
          status: "resolved" as const,
        })),
      };
    },
  },
  {
    name: "merge_check_finished",
    condition: () => {
      event(
        "merge_check_queued",
        { attempt_id: "merge-1", status: "queued" },
        system,
        id("card", 2),
      );
      return { kind: "merge_check_finished", target_id: "merge-1" };
    },
    settle: () => {
      event(
        "merge_check_finished",
        { attempt_id: "merge-1", status: "passed" },
        system,
        id("card", 2),
      );
    },
  },
  {
    name: "github_run_completed",
    condition: () => {
      event(
        "github_check_dispatch",
        { externalRun: { run_id: 77 }, finished: false },
        system,
        id("card", 2),
      );
      return { kind: "github_run_completed", target_id: "77" };
    },
    settle: () => {
      event(
        "github_check_dispatch",
        { externalRun: { run_id: 77 }, finished: true },
        system,
        id("card", 2),
      );
    },
  },
];
test.each(verifiable)(
  "other verifiable prerequisite $name clears inline only once satisfied",
  async ({ condition, settle }) => {
    const c = condition();
    block(c);
    expectStillBlocked(await deliver(), c.target_id);
    settle();
    const effect = await delivered();
    expect(
      effect.events.find((e) => e.type === "blocker_wait_delivered")?.payload,
    ).toMatchObject({ condition: c });
    expect(item()?.status).toBe("delivered");
  },
);

test.each([
  "hold",
  "stopped",
  "blocking decision",
  "merge prerequisite",
  "unstructured blocker",
  "baseline wait",
  "stopping run",
  "cancelled",
])("%s is never unlocked by a delivery", async (guard) => {
  if (guard === "unstructured blocker") block();
  else if (guard === "baseline wait") {
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.id === owner ? { ...a, base_sha: deployed } : a,
      ),
    };
    block({ kind: "baseline_updated", target_id: deployed });
  } else block({ kind: "card_merged", target_id: id("card", 2) });
  mergeCard2();
  if (guard === "hold")
    state = {
      ...state,
      cards: state.cards.map((c) =>
        c.id === id("card", 1)
          ? {
              ...c,
              hold: {
                reason: "Paused",
                set_at: io.clock.now(),
                set_by: "human",
                resume_condition: "PM resumes",
              },
            }
          : c,
      ),
    };
  if (guard === "stopped")
    event("assignment_stopped", { assignment_id: owner }, human, id("card", 1));
  if (guard === "blocking decision")
    state = {
      ...state,
      decisions: [decision({ blocking: true, affected_work_items: [work] })],
    };
  if (guard === "merge prerequisite")
    state = {
      ...state,
      human_actions: [
        {
          id: id("human_action", 1),
          key: id("human_action", 1),
          requested_by: "human",
          instructions: "Connect",
          why_human: "Account",
          expected_return: "Connected",
          blocks_merge: true,
          prerequisite: "external_account",
          blocked_work_items: [work],
          status: "open",
        },
      ],
    };
  if (guard === "stopping run")
    state = {
      ...state,
      runs: state.runs.map((r) =>
        r.id === runId
          ? {
              ...r,
              dispatch_stop: {
                attempt_id: io.ids.nextEventId(),
                runtime_ref: null,
                lease_until: io.clock.now(),
                stopping: false,
              },
            }
          : r,
      ) as CommandState["runs"],
    };
  if (guard === "cancelled")
    state = {
      ...state,
      cards: state.cards.map((c) =>
        c.id === id("card", 1) ? { ...c, status: "cancelled" } : c,
      ),
    };
  const result = await deliver().catch((error: unknown) => ({
    ok: false as const,
    error: { code: "rejected", message: String(error) },
  }));
  const reasons: Record<string, string> = {
    hold: "工作项仍有阻塞：卡片已暂停",
    stopped: "工作项仍有阻塞：指派已被人工停止",
    "blocking decision": "工作项仍有阻塞：拍板 Q-1 尚未解决",
    "merge prerequisite": "工作项仍有阻塞：合并前置操作 H-1 尚未完成",
    "unstructured blocker": "工作项仍有阻塞：阻塞没有登记可核验的解除条件",
    "baseline wait": "工作项仍有阻塞：baseline_updated 等待由系统恢复",
    "stopping run": "工作项仍有阻塞：Run 正在停止",
    cancelled: "Card is closed or awaiting merge",
  };
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain(reasons[guard]);
  expect(item()?.status).toBe("blocked");
  expect(item()?.reported_blocker).toBeDefined();
  expect(state.events.some((e) => e.type === "blocker_wait_delivered")).toBe(
    false,
  );
});

test("a re-reported blocker on an already consumed condition stays with PM", async () => {
  const condition = { kind: "card_merged" as const, target_id: id("card", 2) };
  block(condition);
  finish();
  mergeCard2();
  expect(scan().data).toEqual([work]);
  // The woken session reports the same, already satisfied condition again.
  state = { ...state, runs: [...state.runs, makeRun(4, 1)] };
  block(condition);
  expect(item()?.reported_blocker?.auto_resume_disabled).toBe(true);
  expectStillBlocked(await deliver(), "同一解除条件已用过");
});

test("an inline recovery consumes the condition; a later identical report is not auto-resumed again", async () => {
  const condition = { kind: "card_merged" as const, target_id: id("card", 2) };
  block(condition);
  mergeCard2();
  await delivered();
  state = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === work ? { ...w, status: "in_progress" } : w,
    ),
  };
  block(condition);
  expect(item()?.reported_blocker?.auto_resume_disabled).toBe(true);
  finish();
  expect(scan().data).toEqual([]);
});

test("background recovery first, then delivery: one resume, no inline duplicate", async () => {
  const condition = {
    kind: "deployment_ready" as const,
    target_id: deployed,
  };
  block(condition);
  finish();
  deploy(deployed, "deployed", true);
  const blockerEvent = state.events.findLast(
    (e) => e.type === "blocker_reported",
  );
  const resumed = scan();
  expect(resumed.data).toEqual([work]);
  // The automatic recovery record links back to the cleared report.
  expect(resumed.events[0]?.payload).toMatchObject({
    condition,
    blocker_event_id: blockerEvent?.id,
    blocker_reported_by: `assignment:${owner}`,
  });
  expect(scan().events).toEqual([]);
  state = { ...state, runs: [...state.runs, makeRun(4, 1)] };
  const effect = await delivered();
  expect(effect.events.some((e) => e.type === "blocker_wait_delivered")).toBe(
    false,
  );
  expect(
    state.events.filter((e) => e.type === "work_item_resume_requested"),
  ).toHaveLength(1);
  expect(scan().events).toEqual([]);
});

test("two deliveries racing from the same blocked snapshot: the second sees the first's result", async () => {
  block({ kind: "card_merged", target_id: id("card", 2) });
  mergeCard2();
  const snapshot = state;
  const receipt = value(
    await prepareDelivery(snapshot, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const first = value(submitDelivery(snapshot, actor(), params, receipt, io));
  state = apply(snapshot, first);
  // A store serializes writes, so the second command runs on the committed state.
  const second = submitDelivery(state, actor(), params, receipt, io);
  const after = second.ok ? apply(state, second.value) : state;
  expect(
    after.events.filter((e) => e.type === "blocker_wait_delivered"),
  ).toHaveLength(1);
  expect(after.runs.filter((r) => r.status === "queued")).toHaveLength(0);
});

test("delivery keeps the precheck gate when a merge gate is enabled", async () => {
  state = {
    ...state,
    cards: state.cards.map((c) => ({ ...c, flow_version: 3 })),
    project_settings: { merge_gate_enabled: true },
  };
  block({ kind: "card_merged", target_id: id("card", 2) });
  mergeCard2();
  const prepared = await prepareDelivery(state, actor(), params, {
    verify: async () => ({ ok: true, value: [] }),
  });
  expect(prepared.ok).toBe(false);
  expect(item()?.status).toBe("blocked");
});
