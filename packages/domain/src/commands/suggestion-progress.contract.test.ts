import { expect, test } from "vitest";
import type { Assignment, Decision, Event } from "../entities.js";
import {
  postComment,
  recordDecision,
  remindSuggestionProgress,
  requestDecision,
  resolveDelegatedDecision,
  suggestionView,
  updateCard,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  card,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

function setup() {
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  let state = {
    ...fixture(),
    cards: [card(1), card(2)],
    assignments: [...fixture().assignments, ops],
  };
  let at = now;
  const io = { ...ports(), clock: { now: () => at } };
  const requested = value(
    requestDecision(
      state,
      human,
      {
        card_id: id("card", 1),
        kind: "choose",
        category: "permission",
        question: "选择方案",
        context: "合成证据",
        decider: "human",
        blocking: false,
        options: [
          { key: "yes", description: "继续", impact: "继续" },
          { key: "no", description: "等待", impact: "等待" },
        ],
        recommended: "yes",
        suggestion: { option: "yes", rationale: "已核对" },
        affected_cards: [id("card", 1), id("card", 2), id("card", 2)],
        affected_work_items: [],
        plain_summary: {
          changed: "核对合成证据",
          impact: "由人选择方案",
          risk: "无",
        },
      },
      io,
    ),
  );
  state = apply(state, requested) as typeof state;
  const q = () =>
    state.decisions.find((q) => q.id === requested.data.id) as Decision;
  const commit = (result: ReturnType<typeof postComment>) => {
    state = apply(state, value(result)) as typeof state;
  };
  return {
    get state() {
      return state;
    },
    set state(next: typeof state) {
      state = next;
    },
    io,
    q,
    time(ms: number) {
      at = new Date(Date.parse(now) + ms).toISOString();
    },
    comment(cardNumber = 1) {
      commit(
        postComment(
          state,
          human,
          { card_id: id("card", cardNumber), body: "新的证据" },
          io,
        ),
      );
    },
    remind() {
      const effect = value(
        remindSuggestionProgress(
          state,
          { kind: "system", project_id: state.project_id },
          io,
        ),
      );
      state = apply(state, effect) as typeof state;
      return effect;
    },
    refresh(option = "no", rationale = "证据需要继续核对") {
      const effect = value(
        resolveDelegatedDecision(
          state,
          actor(900, "pm"),
          {
            decision_id: q().id,
            option: "yes",
            rationale: "复核了新增证据",
            escalate: true,
            suggestion: { option, rationale },
          },
          io,
        ),
      );
      state = apply(state, effect) as typeof state;
      return effect;
    },
  };
}

test("C-303: per-card baselines, same-time evidence, duplicate scope and legacy suggestions", () => {
  const f = setup();
  expect(f.q().suggestion?.evidence_baseline).toEqual({ "C-1": 0, "C-2": 0 });
  f.comment();
  f.comment(2);
  const view = suggestionView(f.state, f.q());
  expect(view?.progress?.count).toBe(2);
  expect(view?.progress?.entries.map((e) => e.summary)).toEqual([
    "新的证据",
    "新的证据",
  ]);
  expect(view).not.toHaveProperty("evidence_baseline");
  const { evidence_baseline: _baseline, ...legacy } = required(
    f.q().suggestion,
  );
  expect(
    suggestionView(f.state, { ...f.q(), suggestion: legacy })?.progress,
  ).toBeUndefined();
  const duplicate = required(f.state.events.at(-1));
  f.state = { ...f.state, events: [...f.state.events, duplicate] };
  expect(suggestionView(f.state, f.q())?.progress?.count).toBe(2);
});

test("C-303: only evidence events count; foreign projects and system comments stay out", () => {
  const f = setup();
  const types = [
    "delivery_submitted",
    "review_submitted",
    "human_action_completed",
    "completion_reviewed",
    "merge_check_finished",
    "merge_check_finished",
    "merge_check_finished",
    "run_started",
    "heartbeat",
    "decision_suggestion_updated",
    "comment_posted",
  ];
  const events: Event[] = types.map((type, i) => ({
    id: `event-${i}` as Event["id"],
    card_id: id("card", 2),
    seq: i + 1,
    type,
    actor: { kind: "system", project_id: f.state.project_id },
    created_at: now,
    payload: {
      status: [4, 5].includes(i) ? (i === 4 ? "passed" : "failed") : "running",
    },
  }));
  events.push({
    ...required(events[0]),
    id: "foreign" as Event["id"],
    actor: { ...human, project_id: "foreign" },
  });
  f.state = { ...f.state, events: [...f.state.events, ...events] };
  expect(suggestionView(f.state, f.q())?.progress?.count).toBe(6);
});

test("C-303: first reminder immediately, exact five-minute boundary, quiet windows and durable restart", () => {
  const f = setup();
  f.comment();
  expect(f.remind().events).toHaveLength(1);
  f.comment(2);
  f.time(299_999);
  expect(f.remind().events).toEqual([]);
  // JSON is the Decision repository's durable representation, not process memory.
  f.state = JSON.parse(JSON.stringify(f.state));
  f.time(300_000);
  expect(f.remind().events).toHaveLength(1);
  f.time(600_000);
  expect(f.remind().events).toEqual([]);
  f.comment();
  expect(f.remind().events).toHaveLength(1);
  expect(f.remind().events).toEqual([]);
});

test("C-303: refresh preserves authority, resolution, options and the reminder budget", () => {
  const f = setup();
  f.comment();
  f.remind();
  const before = f.q();
  const token = suggestionView(f.state, before)?.progress?.token;
  f.refresh();
  expect(f.q()).toMatchObject({
    decider: before.decider,
    status: before.status,
    options: before.options,
  });
  expect(f.q().resolution).toEqual(before.resolution);
  expect(f.q().human_required_reason).toEqual(before.human_required_reason);
  expect(suggestionView(f.state, f.q())?.progress).toBeUndefined();
  expect(
    recordDecision(
      f.state,
      human,
      {
        decision_id: f.q().id,
        option: "no",
        rationale: "",
        raw_quote: "",
        via_suggestion: true,
        suggestion_version: required(suggestionView(f.state, f.q())).version,
        suggestion_progress_token: required(token),
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  f.comment(2); // Event after the refresh must survive, including the same timestamp.
  expect(suggestionView(f.state, f.q())?.progress?.count).toBe(1);
  expect(f.remind().events).toEqual([]);
  f.time(300_000);
  expect(f.remind().events).toHaveLength(1);
});

test("C-303: soft confirmation rejects unseen evidence and never overrides hard staleness", () => {
  const f = setup();
  f.comment();
  const decide = (token?: string) =>
    recordDecision(
      f.state,
      human,
      {
        decision_id: f.q().id,
        option: "yes",
        rationale: "",
        raw_quote: "",
        via_suggestion: true,
        suggestion_version: required(suggestionView(f.state, f.q())).version,
        ...(token ? { suggestion_progress_token: token } : {}),
      },
      f.io,
    );
  expect(decide()).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  const token = suggestionView(f.state, f.q())?.progress?.token;
  f.comment(2);
  expect(decide(token)).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  const current = suggestionView(f.state, f.q())?.progress?.token;
  expect(decide(current).ok).toBe(true);
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      pre_merge_checks: [
        {
          label: "验证",
          status: "pending",
          updated_at: now,
          updated_by: "human",
        },
      ],
    })),
  };
  expect(decide(current)).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
});

test("C-303: sensitive progress and notifications contain no evidence body", () => {
  const f = setup();
  f.comment(2);
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, sensitive: true })),
  };
  const view = suggestionView(f.state, f.q());
  expect(view?.progress?.count).toBe(1);
  expect(JSON.stringify(view)).not.toContain("新的证据");
  expect(JSON.stringify(f.remind().events)).not.toContain("新的证据");
});

test("C-303: refresh is forbidden to non-Ops and cannot change a resolved decision", () => {
  const f = setup();
  const input = {
    decision_id: f.q().id,
    option: "yes",
    rationale: "复核",
    escalate: true,
    suggestion: { option: "yes", rationale: "复核" },
  };
  expect(resolveDelegatedDecision(f.state, actor(), input, f.io).ok).toBe(
    false,
  );
  const effect = value(
    recordDecision(
      f.state,
      human,
      {
        decision_id: f.q().id,
        option: "yes",
        rationale: "选择",
        raw_quote: "选择",
      },
      f.io,
    ),
  );
  f.state = apply(f.state, effect) as typeof f.state;
  expect(
    resolveDelegatedDecision(f.state, actor(900, "pm"), input, f.io).ok,
  ).toBe(false);
  expect(f.remind().events).toEqual([]);
});

test("C-303: only the host can notify; absence of Ops does not consume the first reminder", () => {
  const f = setup();
  f.comment();
  for (const caller of [human, actor(900, "pm")])
    expect(remindSuggestionProgress(f.state, caller, f.io)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  const assignments = f.state.assignments;
  f.state = {
    ...f.state,
    assignments: assignments.filter((a) => a.id !== "A-900"),
  };
  expect(f.remind().events).toEqual([]);
  expect(f.q().suggestion?.progress_notice).toBeUndefined();
  f.state = { ...f.state, assignments };
  expect(f.remind().events).toHaveLength(1);
});

test("C-303: an existing PM handoff also preserves the same decision's reminder budget", () => {
  const f = setup();
  f.comment();
  f.remind();
  f.state = {
    ...f.state,
    decisions: f.state.decisions.map((q) => ({
      ...q,
      decider: "role:pm",
      category: "general",
    })),
  };
  f.refresh();
  expect(f.q().decider).toBe("human");
  expect(f.q().suggestion?.progress_notice?.at).toBe(now);
  f.comment();
  expect(f.remind().events).toEqual([]);
  f.time(300_000);
  expect(f.remind().events).toHaveLength(1);
});

test.each(["reason", "soft", "hard"])(
  "C-303: an in-flight request cannot adopt a refreshed suggestion after %s changes",
  (change) => {
    const f = setup();
    const shown = required(suggestionView(f.state, f.q()));
    const payload = {
      decision_id: f.q().id,
      option: "yes",
      rationale: "",
      raw_quote: "",
      via_suggestion: true,
      suggestion_version: shown.version,
    };
    const decide = (p = payload) => recordDecision(f.state, human, p, f.io);
    expect(decide().ok).toBe(true);
    if (change === "soft") f.comment(2);
    if (change === "hard") {
      f.state = apply(
        f.state,
        value(
          updateCard(
            f.state,
            human,
            {
              card_id: id("card", 1),
              pre_merge_check: { label: "合成核对", status: "pending" },
            },
            f.io,
          ),
        ),
      ) as typeof f.state;
    }
    if (change !== "reason")
      expect(decide()).toMatchObject({
        ok: false,
        error: { code: "stale_target" },
      });
    // The timestamp and option deliberately stay identical. Versioning must
    // survive refresh and persistence even when the evidence set becomes empty.
    f.refresh("yes", "新理由：存在需要人知晓的新风险");
    f.state = JSON.parse(JSON.stringify(f.state));
    const current = required(suggestionView(f.state, f.q()));
    expect(current.version).toBe(shown.version + 1);
    expect(current.progress).toBeUndefined();
    expect(current.stale).toBe(false);
    expect(decide()).toMatchObject({
      ok: false,
      error: { code: "stale_target" },
    });
    expect(f.q().resolution).toBeUndefined();
    expect(
      value(decide({ ...payload, suggestion_version: current.version })).data
        .resolution,
    ).toMatchObject({
      resolved_by: "human",
      rationale: current.rationale,
      via_suggestion: true,
    });
  },
);

test("C-303: legacy suggestions require the displayed zero version and refresh to version one", () => {
  const f = setup();
  const {
    version: _version,
    evidence_baseline: _baseline,
    ...legacy
  } = required(f.q().suggestion);
  f.state = {
    ...f.state,
    decisions: f.state.decisions.map((q) => ({ ...q, suggestion: legacy })),
  };
  const shown = required(suggestionView(f.state, f.q()));
  expect(shown.version).toBe(0);
  expect(shown.progress).toBeUndefined();
  const payload = {
    decision_id: f.q().id,
    option: "yes",
    rationale: "",
    raw_quote: "",
    via_suggestion: true,
  };
  expect(recordDecision(f.state, human, payload, f.io)).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  expect(
    recordDecision(f.state, human, { ...payload, suggestion_version: 0 }, f.io)
      .ok,
  ).toBe(true);
  f.refresh("yes");
  expect(suggestionView(f.state, f.q())?.version).toBe(1);
  expect(
    recordDecision(f.state, human, { ...payload, suggestion_version: 0 }, f.io),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
});

test("C-309: suggestion refresh cannot accept merge decision evidence", () => {
  const f = setup();
  const before = JSON.stringify(f.state);
  const result = resolveDelegatedDecision(
    f.state,
    actor(900, "pm"),
    {
      decision_id: f.q().id,
      option: "yes",
      rationale: "复核新增证据",
      escalate: true,
      suggestion: { option: "no", rationale: "继续核对" },
      decision_evidence: [],
    },
    f.io,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("validation_failed");
  expect(JSON.stringify(f.state)).toBe(before);
});
