import { beforeEach, expect, test } from "vitest";
import type { TimelineEntry } from "../entities.js";
import {
  assign,
  completeHumanAction,
  createCard,
  createWorkItem,
  extractReferences,
  finishRun,
  heartbeat,
  listNeedsYou,
  postComment,
  prepareAttachment,
  projectSnapshot,
  type RequestDecisionParams,
  recordDecision,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  resolveDelegatedDecision,
  type StoredAttachment,
  setProjectPreferences,
  updateCard,
  updateWorkItem,
  uploadAttachment,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

let io = ports();
beforeEach(() => {
  io = ports();
});
const office = actor(4, "pm");
const decision: RequestDecisionParams = {
  card_id: id("card", 1),
  category: "general",
  kind: "choose",
  question: "Choose",
  context: "A choice is needed",
  options: [{ key: "go", description: "Continue", impact: "Unblocks work" }],
  recommended: "go",
  affected_cards: [id("card", 1)],
  affected_work_items: [id("work_item", 1)],
  blocking: true,
  decider: "human",
  plain_summary: TEST_PLAIN_SUMMARY,
};
const comment = { card_id: id("card", 1), body: "See C-2 and q(1)" };
const humanRequest = {
  card_id: id("card", 1),
  instructions: "Connect the device",
  why_human: "Physical device",
  expected_return: "Connection result",
  blocked_work_items: [id("work_item", 1)],
};
const cardParams = {
  title: "New",
  goal: "Build",
  acceptance_criteria: ["Works"],
  source: { kind: "quote" as const, text: "Build it" },
  repo: "example/repo",
  base_branch: "main",
};

test("invariants 10, 11: comments extract references, trust Actor, and never create a Run", () => {
  const state = fixture();
  const result = value(
    postComment(
      state,
      actor(),
      {
        ...comment,
        body: "见C-1#2、q(2)、h(3)、D-4、C-2 C-2 https://github.com/example/repo/pull/12 https://gitlab.example/project/repo/-/merge_requests/3",
      },
      io,
    ),
  );
  expect(result.data?.refs).toHaveLength(7);
  expect(result.data?.refs).toContainEqual({
    kind: "decision",
    id: id("decision", 2),
  });
  expect(result.data?.refs).toContainEqual({
    kind: "pr",
    url: "https://github.com/example/repo/pull/12",
  });
  expect(result.data?.author).toBe("assignment:A-1");
  expect(result.changes).toEqual([]);
  expect(state.timeline).toEqual([]);
  expect(extractReferences("C-01 q(01) C-9007199254740992")).toEqual([]);
});

test("invariant 11: only the same author may supersede a comment; links stay on the card", () => {
  const first = value(postComment(fixture(), actor(), comment, io));
  const state = apply(fixture(), first);
  const entry = first.data as TimelineEntry;
  expect(
    postComment(
      state,
      actor(2, "reviewer"),
      { ...comment, supersedes: entry.id },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(
    value(
      postComment(
        state,
        actor(),
        { ...comment, supersedes: entry.id, reply_to: entry.id },
        io,
      ),
    ).data?.supersedes,
  ).toBe(entry.id);
  expect(
    postComment(state, actor(), { ...comment, body: "" }, io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    postComment(state, actor(), { ...comment, card_id: id("card", 2) }, io),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("invariants 5, 10, 12: blocking decisions end Runs; resolving queues a new Run without reopening the old one", () => {
  const initial = fixture();
  const requested = value(requestDecision(initial, actor(), decision, io));
  let state = apply(initial, requested);
  expect(state.runs.find((r) => r.id === id("run", 1))).toMatchObject({
    status: "completed",
    outcome: "blocked",
    role_version: 1,
    model: "fixture-model",
    agent_cli_version: "1.0",
  });
  expect(
    value(
      finishRun(
        state,
        actor(),
        { run_id: id("run", 1), outcome: "blocked", summary: "Waiting" },
        io,
      ),
    ).changes,
  ).toEqual([]);
  const resolved = value(
    recordDecision(
      state,
      office,
      {
        decision_id: requested.data.id,
        option: "go",
        rationale: "Approved",
        raw_quote: "  go  ",
        batch: "batch-1",
        via_chain: ["human"],
      },
      io,
    ),
  );
  state = apply(state, resolved);
  expect(resolved.data.resolution).toMatchObject({
    raw_quote: "  go  ",
    batch: "batch-1",
    via_chain: ["human", "assignment:A-4"],
  });
  expect(
    state.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("in_progress");
  expect(state.runs.find((r) => r.id === id("run", 1))?.status).toBe(
    "completed",
  );
  expect(state.assignments).toEqual(initial.assignments);
  expect(resolved.events[0]?.type).toBe("decision_resolved");
  expect(resolved.events[0]?.id).not.toBe(requested.events[0]?.id);
  expect(state.runs).toHaveLength(initial.runs.length + 1);
  expect(state.runs.find((r) => r.kind === "decision_resumed")).toMatchObject({
    assignment_id: id("assignment", 1),
    trigger_event_id: resolved.events[0]?.id,
    status: "queued",
    role_version: 1,
    model: "fixture-model",
    agent_cli_version: "1.0",
    outcome: null,
  });
});

test.each(["permission"] as const)(
  "invariant 11: %s decisions must be made by the human",
  (category) => {
    expect(
      requestDecision(
        fixture(),
        actor(),
        { ...decision, category, decider: "role:pm" },
        io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(
      requestDecision(fixture(), actor(), { ...decision, category }, io).ok,
    ).toBe(true);
  },
);

test.each(["spending", "account", "data_deletion"] as const)(
  "invariant 11: %s requests follow the human grant, never the requested PM alone",
  (category) => {
    let state = fixture();
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.scope === "standing" && a.id === id("assignment", 4)
          ? { ...a, standing_mode: "ops" as const }
          : a,
      ),
    };
    const ask = () =>
      value(
        requestDecision(
          state,
          actor(),
          {
            ...decision,
            category,
            decider: "role:pm",
            blocking: false,
          },
          io,
        ),
      );
    const answer = (decision_id: ReturnType<typeof ask>["data"]["id"]) =>
      resolveDelegatedDecision(
        state,
        office,
        {
          decision_id,
          option: "go",
          rationale: "Check the current authorization",
        },
        io,
      );
    const checkHuman = () => {
      const effect = ask();
      state = apply(state, effect);
      expect(effect.data.decider).toBe("human");
      expect(effect.data.delegation_authority).toBeUndefined();
      expect(answer(effect.data.id).ok).toBe(false);
    };
    checkHuman(); // Defaults remain off even with an active PM Ops.
    for (const enabled of [false, true]) {
      for (const identity of [actor(), office])
        expect(
          setProjectPreferences(
            state,
            identity,
            {
              decision_delegation: { [category]: enabled },
            },
            io,
          ).ok,
        ).toBe(false);
      state = apply(
        state,
        value(
          setProjectPreferences(
            state,
            human,
            {
              decision_delegation: { [category]: enabled },
            },
            io,
          ),
        ),
      );
      if (!enabled) checkHuman();
    }
    const grant = state.events.findLast(
      (e) => e.type === "project_preferences_updated",
    );
    const effect = ask();
    state = apply(state, effect);
    expect(effect.data).toMatchObject({
      decider: "role:pm",
      delegation_authority: `project:${state.project_id}/decision_delegation/${category}/event:${grant?.id}`,
    });
    expect(grant?.actor).toEqual(human);
    expect(answer(effect.data.id).ok).toBe(true);
    const unavailable = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.id === id("assignment", 4)
          ? { ...a, status: "suspended" as const }
          : a,
      ),
    };
    const fallback = value(
      requestDecision(
        unavailable,
        actor(),
        {
          ...decision,
          category,
          decider: "role:pm",
          blocking: false,
        },
        io,
      ),
    ).data;
    expect(fallback.decider).toBe("human");
    expect(fallback.delegation_authority).toBeUndefined();
    state = apply(
      state,
      value(
        setProjectPreferences(
          state,
          human,
          {
            decision_delegation: { [category]: false },
          },
          io,
        ),
      ),
    );
    expect(state.decisions.find((q) => q.id === effect.data.id)?.decider).toBe(
      "human",
    );
    expect(answer(effect.data.id).ok).toBe(false);
    checkHuman();
  },
);

test("invariant 11: decision inputs and PM Office authority are checked", () => {
  expect(
    requestDecision(
      fixture(),
      actor(),
      { ...decision, decider: undefined } as unknown as RequestDecisionParams,
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    requestDecision(
      fixture(),
      actor(),
      { ...decision, recommended: "absent" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    requestDecision(fixture(), actor(), { ...decision, kind: "approve" }, io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    requestDecision(
      fixture(),
      actor(),
      {
        ...decision,
        kind: "approve",
        target: { subject: { kind: "doc_version", value: "v1" } },
      },
      io,
    ).ok,
  ).toBe(true);
  const requested = value(requestDecision(fixture(), actor(), decision, io));
  const state = apply(fixture(), requested);
  const p = {
    decision_id: requested.data.id,
    option: "go",
    rationale: "Because",
    raw_quote: "go",
  };
  expect(recordDecision(state, human, p, io)).toMatchObject({
    ok: true,
    value: { data: { resolution: { via: "needs_you", resolved_by: "human" } } },
  });
  expect(recordDecision(state, actor(3, "pm"), p, io)).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
  expect(
    recordDecision(state, office, { ...p, raw_quote: "" }, io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    recordDecision(state, office, { ...p, option: "absent" }, io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("invariants 10, 11: a second blocking decision prevents premature resumption", () => {
  const first = value(requestDecision(fixture(), actor(), decision, io));
  let state = apply(fixture(), first);
  const second = value(requestDecision(state, actor(), decision, io));
  state = apply(state, second);
  state = apply(
    state,
    value(
      recordDecision(
        state,
        office,
        {
          decision_id: first.data.id,
          option: "go",
          rationale: "Approved",
          raw_quote: "go",
        },
        io,
      ),
    ),
  );
  expect(
    state.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("waiting_decision");
  expect(state.runs.some((r) => r.kind === "decision_resumed")).toBe(false);
});

test("invariant 11: human actions block work and only the human can complete them", () => {
  const requested = value(
    requestHumanAction(fixture(), actor(), humanRequest, io),
  );
  let state = apply(fixture(), requested);
  expect(
    state.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("blocked");
  expect(
    completeHumanAction(
      state,
      actor(),
      { human_action_id: requested.data.id, text: "Done" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  state = apply(
    state,
    value(
      completeHumanAction(
        state,
        human,
        { human_action_id: requested.data.id, text: "Connected" },
        io,
      ),
    ),
  );
  expect(state.human_actions[0]?.status).toBe("done");
  expect(
    state.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("in_progress");
  expect(
    completeHumanAction(
      state,
      human,
      { human_action_id: requested.data.id, text: "Again" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
});

test("invariant 11: rejection exposes no partial work-item changes", () => {
  const initial = fixture();
  const before = JSON.stringify(initial);
  const result = requestHumanAction(
    initial,
    actor(),
    {
      ...humanRequest,
      blocked_work_items: [id("work_item", 1), id("work_item", 2)],
    },
    io,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  expect(result).not.toHaveProperty("value");
  expect(JSON.stringify(initial)).toBe(before);
  expect(
    requestHumanAction(
      initial,
      actor(),
      { ...humanRequest, instructions: "" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("invariants 8, 11: reporting a human blocker guides the caller to structured requests", () => {
  const result = value(
    reportBlocker(
      fixture(),
      actor(),
      {
        work_item_id: id("work_item", 1),
        reason: "Need a device",
        needs: "human",
      },
      io,
    ),
  );
  expect(result.data.guidance).toContain("request_human_action");
  expect(
    apply(fixture(), result).work_items.find((w) => w.id === id("work_item", 1))
      ?.status,
  ).toBe("blocked");
  expect(
    reportBlocker(
      fixture(),
      actor(2, "reviewer"),
      { work_item_id: id("work_item", 1), reason: "No", needs: "role" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("invariants 1, 2, 5: PM creates the template and one persistent assignment without runtime ownership on Role", () => {
  const initial = fixture();
  const created = value(createCard(initial, office, cardParams, io));
  let state = apply(initial, created);
  const work = state.work_items.filter((w) => w.card_id === created.data.id);
  expect(work.map((w) => [w.kind, w.role_id, w.required])).toEqual([
    ["produce", "coder", true],
    ["verify", "reviewer", true],
    ["verify", "pm", true],
  ]);
  const coder = work.find((w) => w.kind === "produce");
  if (!coder) throw new Error("Missing producer");
  const assigned = value(
    assign(state, office, { work_item_id: coder.id, role_id: "coder" }, io),
  );
  state = apply(state, assigned);
  expect(assigned.data).toMatchObject({
    runtime_ref: null,
    runtime_state: "not_provisioned",
    machine_id: "local",
  });
  expect(assigned.token_requests[0]).toMatchObject({
    assignment_id: assigned.data.id,
    token_id: assigned.data.mcp_token_id,
    role_version: 1,
  });
  expect(assigned.token_requests[0]).not.toHaveProperty("token");
  expect(
    value(
      assign(state, office, { work_item_id: coder.id, role_id: "coder" }, io),
    ).changes,
  ).toEqual([]);
  expect(state.roles).toEqual(initial.roles);
  expect(state.runs).toEqual(initial.runs);
  expect(
    value(
      assign(
        fixture(),
        office,
        { work_item_id: id("work_item", 1), role_id: "coder" },
        io,
      ),
    ).data.session_ref,
  ).toBe("fixture-session");
});

test("invariants 2, 11, 13: PM tools reject role violations and manual completion", () => {
  expect(
    updateWorkItem(
      fixture(),
      office,
      { work_item_id: id("work_item", 1), status: "accepted" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(createCard(fixture(), actor(), cardParams, io)).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
  expect(
    createCard(
      fixture(),
      office,
      { ...cardParams, acceptance_criteria: [] },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    updateCard(
      fixture(),
      office,
      { card_id: id("card", 1), status: "done" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(
    updateWorkItem(
      fixture(),
      office,
      { work_item_id: id("work_item", 1), required: false },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  expect(
    assign(
      fixture(),
      office,
      { work_item_id: id("work_item", 1), role_id: "reviewer" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    assign(
      fixture(),
      office,
      {
        work_item_id: id("work_item", 1),
        role_id: "coder",
        machine_id: "worker-a",
      },
      io,
    ),
  ).toMatchObject({
    ok: false,
    // This work item is already assigned: changing its machine breaks ownership.
    error: {
      code: "invariant_violation",
      message: "Assignment 的机器创建后不能修改",
    },
  });
});

test("invariant 11: PM can update metadata and add a verifier; only Ops/human may raise limits", () => {
  const state = fixture();
  expect(
    value(
      updateCard(
        state,
        office,
        { card_id: id("card", 1), title: "Renamed" },
        io,
      ),
    ).data.title,
  ).toBe("Renamed");
  const work = {
    card_id: id("card", 1),
    title: "Extra test",
    kind: "verify" as const,
    role_id: "reviewer",
    required: false,
    completion_criteria: ["Pass"],
    target_work_item_id: id("work_item", 1),
  };
  expect(value(createWorkItem(state, office, work, io)).data).toMatchObject({
    status: "todo",
    kind: "verify",
    max_review_rounds: 5,
  });
  expect(createWorkItem(state, actor(), work, io)).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
  expect(
    createWorkItem(
      state,
      office,
      { ...work, target_work_item_id: id("work_item", 2) },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    updateWorkItem(
      state,
      office,
      { work_item_id: id("work_item", 2), max_review_rounds: 5 },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  const raised = value(
    updateWorkItem(
      state,
      human,
      {
        work_item_id: id("work_item", 2),
        title: "Review again",
        max_review_rounds: 5,
      },
      io,
    ),
  );
  expect(raised.data).toMatchObject({
    title: "Review again",
    max_review_rounds: 5,
  });
  expect(
    apply(state, raised).runs.find((r) => r.id === id("run", 2))
      ?.review_limit_changes?.[0],
  ).toMatchObject({ max_review_rounds: 5, actor: "human" });
});

test("invariants 5, 8, 10, 12: heartbeat/finish affect only the caller's Run, not delivery or session success", () => {
  const state = fixture();
  const beat = value(
    heartbeat(state, actor(), { run_id: id("run", 1), note: "Working" }, io),
  );
  expect(beat.data.heartbeat_at).toBe(now);
  expect(beat.timeline).toEqual([]);
  expect(heartbeat(state, actor(), { run_id: id("run", 2) }, io)).toMatchObject(
    { ok: false, error: { code: "unauthorized" } },
  );
  const finished = value(
    finishRun(
      state,
      actor(),
      { run_id: id("run", 1), outcome: "completed", summary: "Reported" },
      io,
    ),
  );
  const next = apply(state, finished);
  expect(finished.data).toMatchObject({
    status: "completed",
    model: "fixture-model",
    agent_cli_version: "1.0",
    role_version: 1,
  });
  expect(next.work_items).toEqual(state.work_items);
  expect(next.cards).toEqual(state.cards);
  expect(next.assignments).toEqual(state.assignments);
  expect(
    finishRun(
      next,
      actor(),
      { run_id: id("run", 1), outcome: "failed", summary: "Rewrite" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
});

test("invariants 11, 14: attachments require an actual target and artifacts require a decision basis", async () => {
  const posted = value(postComment(fixture(), actor(), comment, io));
  let state = apply(fixture(), posted);
  const requested = value(
    requestDecision(state, actor(), { ...decision, blocking: false }, io),
  );
  state = apply(state, requested);
  const receipt = value(
    await prepareAttachment("a".repeat(64), new Uint8Array([1, 2]), {
      put: async () => ({ storage_path: "attachments/example" }),
      get: async () => undefined,
    }),
  );
  const target = posted.data;
  if (!target) throw new Error("Missing comment");
  const p = {
    card_id: id("card", 1),
    kind: "artifact" as const,
    mime: "application/octet-stream",
    attach_to: { kind: "timeline_entry" as const, id: target.id },
  };
  expect(uploadAttachment(state, actor(), p, receipt, io)).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  expect(
    uploadAttachment(
      state,
      actor(),
      { ...p, basis: id("decision", 999) },
      receipt,
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(
    uploadAttachment(
      state,
      actor(),
      { ...p, basis: requested.data.id },
      {} as StoredAttachment,
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const attached = value(
    uploadAttachment(
      state,
      actor(),
      { ...p, basis: requested.data.id },
      receipt,
      io,
    ),
  );
  expect(attached.data).toMatchObject({
    uploaded_by: "assignment:A-1",
    basis: requested.data.id,
    size: 2,
  });
});

test("invariant 11: project queries require PM authority", () => {
  let state = fixture();
  expect(value(projectSnapshot(state, office)).data.cards).toHaveLength(2);
  expect(projectSnapshot(state, actor())).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
  const requested = value(requestDecision(state, actor(), decision, io));
  state = apply(state, requested);
  expect(value(listNeedsYou(state, office)).data.decisions[0]?.id).toBe(
    requested.data.id,
  );
  expect(listNeedsYou(state, actor())).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
});

test.each(["assign", "update_card", "update_work_item"] as const)(
  "invariant 11: %s cannot be called by a producer even with a tool grant",
  (tool) => {
    const state = fixture();
    const result =
      tool === "assign"
        ? assign(
            state,
            actor(),
            { work_item_id: id("work_item", 1), role_id: "coder" },
            io,
          )
        : tool === "update_card"
          ? updateCard(
              state,
              actor(),
              { card_id: id("card", 1), title: "No" },
              io,
            )
          : updateWorkItem(
              state,
              actor(),
              { work_item_id: id("work_item", 1), title: "No" },
              io,
            );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "forbidden_tool" },
    });
  },
);

test("invariants 2, 12: duplicate assignments and invalid Run snapshots are rejected", () => {
  const state = fixture();
  const first = state.assignments[0];
  if (!first) throw new Error("Missing assignment");
  expect(
    assign(
      {
        ...state,
        assignments: [
          ...state.assignments,
          { ...first, id: id("assignment", 99) },
        ],
      },
      office,
      { work_item_id: id("work_item", 1), role_id: "coder" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  const broken = {
    ...state,
    runs: state.runs.map((r) =>
      r.id === id("run", 1) ? { ...r, agent_cli_version: "" } : r,
    ),
  };
  expect(
    finishRun(
      broken,
      actor(),
      { run_id: id("run", 1), outcome: "completed", summary: "No" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  expect(
    finishRun(
      state,
      actor(),
      { run_id: id("run", 2), outcome: "completed", summary: "No" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("invariant 11: a PM Ops token can relax limits but cannot record the human's decision", () => {
  const state = fixture();
  const standing = state.assignments.find((a) => a.scope === "standing");
  if (!standing) throw new Error("Missing standing PM");
  const base = actor(5, "pm");
  if (base.kind !== "assignment") throw new Error("Missing actor");
  const ops = {
    ...base,
    allowed_tools: base.allowed_tools.filter(
      (tool) => tool !== "record_decision",
    ),
  };
  const scoped = {
    ...state,
    assignments: [...state.assignments, { ...standing, id: ops.assignment_id }],
  };
  expect(
    value(
      updateWorkItem(
        scoped,
        ops,
        { work_item_id: id("work_item", 2), max_review_rounds: 5 },
        io,
      ),
    ).data,
  ).toMatchObject({ max_review_rounds: 5 });
  expect(
    recordDecision(
      scoped,
      ops,
      {
        decision_id: id("decision", 1),
        option: "go",
        rationale: "No",
        raw_quote: "No",
      },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
});
