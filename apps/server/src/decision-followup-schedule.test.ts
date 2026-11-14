import {
  type Assignment,
  type CommandState,
  type Decision,
  type DecisionId,
  type Event,
  parseEventId,
  postComment,
  type Result,
  remindDecisionFollowups,
  requestDecision,
  type TimelineEntry,
} from "@cardigan/domain";
import type { ChangeSet } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import {
  type DecisionFollowupPlan,
  DecisionFollowupSchedule,
} from "./decision-followup-schedule.js";
import { Dispatcher } from "./dispatch.js";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => f.close());

const system = (state: CommandState) => ({
  kind: "system" as const,
  project_id: state.project_id,
});
const ports = (now: string, n: { value: number }) => ({
  clock: { now: () => now },
  ids: {
    next: () => {
      throw new Error("unused");
    },
    nextTimelineEntryId: (_p: unknown, card: string) =>
      `${card}#${++n.value}` as never,
    nextEventId: () =>
      unwrap(parseEventId(String(++n.value).padStart(26, "0"))),
    nextEventSequence: () => ++n.value,
    nextAttachmentId: () => `att-${++n.value}`,
  },
});

/**
 * An in-memory row change feed over successive states, like the Store's
 * triggers: a decision row changed when its object changed.
 */
function feed() {
  let version = 0;
  let seen = new Map<string, Decision>();
  return {
    /** Changes since `cursor` (undefined: never read, start over). */
    since(state: CommandState, read: boolean): ChangeSet {
      const now = new Map(state.decisions.map((q) => [q.id, q]));
      const ids = new Set<string>();
      for (const [id, q] of now) if (seen.get(id) !== q) ids.add(id);
      for (const id of seen.keys()) if (!now.has(id)) ids.add(id);
      if (ids.size) version++;
      seen = now;
      const cursor = {
        project_id: state.project_id,
        versions: new Map([["decisions", version]]),
      };
      if (!read) return { cursor, changed: undefined };
      return { cursor, changed: new Map([["decisions", ids]]) };
    },
  };
}

/** Plan with a fresh feed read (`changes`), like the dispatcher. */
function planned(
  schedule: DecisionFollowupSchedule,
  state: CommandState,
  changes: ChangeSet | undefined,
  now: string,
): DecisionFollowupPlan {
  return schedule.plan(state, changes, now);
}

/**
 * Like the dispatcher: evaluate what the schedule plans, remind the `due`
 * ones, then record after "commit".
 */
function scheduledPass(
  schedule: DecisionFollowupSchedule,
  state: CommandState,
  changes: ChangeSet,
  now: string,
  n: { value: number },
) {
  const plan = planned(schedule, state, changes, now);
  const statuses = schedule.evaluate(state, plan, now);
  const due = new Set(
    [...statuses].filter(([, s]) => s.kind === "due").map(([q]) => q.id),
  );
  const effect = unwrap(
    remindDecisionFollowups(state, system(state), ports(now, n), {
      decision_ids: due,
    }),
  );
  schedule.record(plan, statuses);
  return { effect, evaluated: statuses.size, planned: plan.ids.size };
}

test("C-244: scheduled reminders equal a full pass every tick over random histories", () => {
  const w = f.create();
  const base = f.state();
  const card = w.card.id;
  const coder = `assignment:${w.assignment.id}` as const;
  const { work_item_id: _w, ...pmBase } = w.assignment;
  let skipped = 0;
  let reminders = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const pick = rng(seed);
    let time = Date.parse("2030-01-01T00:00:00.000Z");
    const n = { value: 1000 };
    const ops: Assignment = {
      ...pmBase,
      id: "A-99" as Assignment["id"],
      scope: "standing",
      role_id: "pm",
      standing_mode: "ops",
    };
    let state: CommandState = {
      ...base,
      assignments: [...base.assignments, ops],
      decisions: [],
      events: [],
      timeline: [],
    };
    const schedule = new DecisionFollowupSchedule();
    const rows = feed();
    let seq = 0;
    const event = (type: string, payload: Record<string, string> = {}) => {
      const e: Event = {
        id: unwrap(parseEventId(String(++n.value).padStart(26, "0"))),
        card_id: card,
        seq: ++seq,
        type,
        actor: { kind: "human", project_id: state.project_id },
        payload,
        created_at: new Date(time).toISOString(),
      };
      state = { ...state, events: [...state.events, e] };
      return e;
    };
    for (let tick = 0; tick < 40; tick++) {
      // Random changes; unchanged decisions keep their objects, like the Store.
      const roll = pick(9);
      const decisions = state.decisions;
      const target = decisions[pick(decisions.length + 1)];
      if (roll === 0 || !decisions.length) {
        const id = `Q-${decisions.length + 1}` as DecisionId;
        const q = {
          id,
          key: id,
          kind: "choose",
          card_id: card,
          raised_by: pick(4) ? coder : "human",
          question: "q",
          context: "c",
          options: [{ key: "go", description: "go", impact: "i" }],
          recommended: "go",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          doc_refs: [],
          status: "open",
        } as Decision;
        state = { ...state, decisions: [...decisions, q] };
      } else if (roll <= 2 && target) {
        // Resolve, or re-resolve with a new resolution time.
        const at = new Date(time).toISOString();
        state = {
          ...state,
          decisions: decisions.map((q) =>
            q === target
              ? {
                  ...q,
                  status: "resolved",
                  resolution: {
                    option: "go",
                    rationale: "r",
                    resolved_by: "human",
                    via: "needs_you",
                    raw_quote: "go",
                    via_chain: [],
                    at,
                  },
                }
              : q,
          ),
        };
        event("decision_resolved", { decision_id: target.id });
      } else if (roll === 3) event("work_item_updated");
      else if (roll === 4 && target) {
        const e = event("comment_posted");
        const authors = [coder, "human", `assignment:${ops.id}`, "system"];
        const entry = {
          id: `${card}#${e.seq}`,
          short_id: `${card}#${e.seq}`,
          card_id: card,
          event_seq: e.seq,
          type: "comment",
          author: authors[pick(authors.length)],
          body: "done",
          refs: [{ kind: "decision", id: target.id }],
          mentions: [],
          retracted: false,
          created_at: e.created_at,
        } as unknown as TimelineEntry;
        state = { ...state, timeline: [...state.timeline, entry] };
      } else if (roll === 5) {
        // PM Ops evidence follows the Assignment, which may change mode.
        state = {
          ...state,
          assignments: state.assignments.map((a) =>
            a.id === ops.id
              ? {
                  ...a,
                  standing_mode:
                    a.standing_mode === "ops"
                      ? ("office" as const)
                      : ("ops" as const),
                }
              : a,
          ),
        };
      }
      time += [60_000, 5 * 60_000, 20 * 60_000, 31 * 60_000][pick(4)] ?? 0;
      const now = new Date(time).toISOString();
      const full = unwrap(
        remindDecisionFollowups(state, system(state), ports(now, n)),
      );
      const changes = rows.since(state, schedule.cursor !== undefined);
      const pass = scheduledPass(schedule, state, changes, now, n);
      const { effect, evaluated } = pass;
      // Settled decisions are not even looked at: nothing walks all of them.
      expect(pass.planned).toBe(evaluated);
      expect(effect.data, `seed ${seed} tick ${tick}`).toEqual(full.data);
      skipped += state.decisions.length - evaluated;
      reminders += effect.data.length;
      // Commit the reminder events, as the dispatcher's transaction does.
      state = {
        ...state,
        events: [...state.events, ...effect.events],
        timeline: [...state.timeline, ...effect.timeline],
      };
    }
  }
  // The schedule really skips settled and waiting decisions.
  expect(skipped).toBeGreaterThan(1000);
  expect(reminders).toBeGreaterThan(50);
});

test("C-244: an uncommitted pass teaches the schedule nothing; a new schedule rebuilds", () => {
  const w = f.create();
  const state = f.state();
  const coder = `assignment:${w.assignment.id}` as const;
  const at = "2030-01-01T00:00:00.000Z";
  const q = {
    id: "Q-1",
    key: "Q-1",
    kind: "choose",
    card_id: w.card.id,
    raised_by: coder,
    question: "q",
    context: "c",
    options: [{ key: "go", description: "go", impact: "i" }],
    recommended: "go",
    affected_cards: [],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    doc_refs: [],
    status: "resolved",
    resolution: {
      option: "go",
      rationale: "r",
      resolved_by: "human",
      via: "needs_you",
      raw_quote: "go",
      via_chain: [],
      at,
    },
  } as unknown as Decision;
  const s: CommandState = { ...state, decisions: [q] };
  const schedule = new DecisionFollowupSchedule();
  const early = "2030-01-01T00:29:59.999Z";
  const due = "2030-01-01T00:30:00.000Z";
  const cursor = (version: number) => ({
    project_id: s.project_id,
    versions: new Map([["decisions", version]]),
  });
  const none: ChangeSet = { cursor: cursor(1), changed: new Map() };
  const ids = (plan: DecisionFollowupPlan) => [...plan.ids];
  const first = schedule.plan(
    s,
    { cursor: cursor(1), changed: undefined },
    early,
  );
  expect(first.reset).toBe(true);
  schedule.record(first, schedule.evaluate(s, first, early));
  expect(schedule.cursor).toEqual(cursor(1));
  // Waiting: nothing to look at until its due time, then it alone.
  expect(ids(schedule.plan(s, none, early))).toEqual([]);
  expect(ids(schedule.plan(s, none, due))).toEqual(["Q-1"]);
  // Evaluated but never recorded (the transaction rolled back): the cursor
  // stays and the decision is still planned.
  const lost = schedule.plan(s, { cursor: cursor(2), changed: new Map() }, due);
  schedule.evaluate(s, lost, due);
  expect(schedule.cursor).toEqual(cursor(1));
  expect(ids(schedule.plan(s, none, due))).toEqual(["Q-1"]);
  // `due` is not remembered either; the next pass sees the reminder event.
  const again = schedule.plan(s, none, due);
  schedule.record(again, schedule.evaluate(s, again, due));
  expect(ids(schedule.plan(s, none, due))).toEqual(["Q-1"]);
  // Once reminded it is settled and no longer planned, at any time.
  const reminded: CommandState = {
    ...s,
    events: [
      {
        id: unwrap(parseEventId("9".padStart(26, "0"))),
        card_id: w.card.id,
        seq: 1,
        type: "decision_followup_due",
        actor: { kind: "system", project_id: s.project_id },
        payload: { decision_id: "Q-1", resolved_at: at },
        created_at: due,
      } as Event,
    ],
  };
  const settle = schedule.plan(reminded, none, due);
  const settled = schedule.evaluate(reminded, settle, due);
  expect([...settled.values()]).toEqual([{ kind: "reminded" }]);
  schedule.record(settle, settled);
  expect(
    ids(schedule.plan(reminded, none, "2031-01-01T00:00:00.000Z")),
  ).toEqual([]);
  // A changed row is planned again; a deleted one is forgotten.
  const changed: ChangeSet = {
    cursor: cursor(2),
    changed: new Map([["decisions", new Set(["Q-1"])]]),
  };
  const replan = schedule.plan(reminded, changed, due);
  expect(ids(replan)).toEqual(["Q-1"]);
  const gone = { ...reminded, decisions: [] };
  schedule.record(replan, schedule.evaluate(gone, replan, due));
  expect(ids(schedule.plan(gone, none, due))).toEqual([]);
  // A restart (new schedule) or a feed that starts over plans every decision.
  expect(ids(new DecisionFollowupSchedule().plan(s, changed, early))).toEqual([
    "Q-1",
  ]);
  expect(ids(schedule.plan(s, undefined, early))).toEqual(["Q-1"]);
});

test("C-244: the dispatcher reminds once per resolution across ticks and restarts", async () => {
  const w = f.create();
  const q = f.apply((s, a, p) =>
    requestDecision(
      s,
      a,
      {
        card_id: w.card.id,
        category: "general",
        kind: "choose",
        question: "继续？",
        context: "c",
        options: [{ key: "go", description: "go", impact: "i" }],
        recommended: "go",
        affected_cards: [w.card.id],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: { changed: "c", impact: "i", risk: "无" },
      },
      p,
    ),
  ) as Decision;
  // Raised by the coder (the fixture role lacks request_decision).
  f.store.uow.run((tx) =>
    tx.decisions.put(f.project, {
      ...q,
      raised_by: `assignment:${w.assignment.id}`,
      status: "resolved",
      resolution: {
        option: "go",
        rationale: "r",
        resolved_by: "human",
        via: "needs_you",
        raw_quote: "go",
        via_chain: [],
        at: f.clock.now(),
      },
    }),
  );
  const options = {
    store: f.store,
    runtime: {
      status: async () => ({
        ok: true as const,
        value: { process: "alive", agent: "working", observed_seq: 1 },
      }),
      wake: async () => ({ ok: true as const, value: { sent: true } }),
    } as never,
    clock: f.clock,
    snapshot: async () => ({ model: "m", agent_cli_version: "v" }),
    startRun: async () => {},
  };
  const reminders = () =>
    f.state().events.filter((e) => e.type === "decision_followup_due").length;
  const dispatcher = new Dispatcher(options);
  f.advance(29 * 60_000);
  await dispatcher.tick();
  expect(reminders()).toBe(0);
  f.advance(60_000);
  await dispatcher.tick();
  expect(reminders()).toBe(1);
  await dispatcher.tick();
  await new Dispatcher(options).tick();
  expect(reminders()).toBe(1);
  // An unrelated comment never counts as implementation; nothing else fires.
  f.apply((s, a, p) =>
    postComment(s, a, { card_id: w.card.id, body: "收到" }, p),
  );
  f.advance(60 * 60_000);
  await dispatcher.tick();
  expect(reminders()).toBe(1);
});
