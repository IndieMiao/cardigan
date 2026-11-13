import { describe, expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  issueInstruction,
  prepareDelivery,
  recordDecision,
  requestDecision,
  requestHumanAction,
  resolveReferences,
  standingTools,
  submitDelivery,
  updateCard,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, id, role, value } from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

function instructionFixture() {
  const f = mergeFixture(),
    a: Assignment = {
      id: id("assignment", 20),
      scope: "standing",
      standing_mode: "ops",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "host-reference",
      created_at: f.io.clock.now(),
    };
  const actor: Actor = {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: a.id,
    ...role("pm"),
  };
  return {
    f,
    a,
    actor,
    state: { ...f.state, assignments: [...f.state.assignments, a] },
    params: {
      card_id: f.card.id,
      work_item_id: f.coder.work_item_id as never,
      body: `Implement ${f.coder.work_item_id}; see q(2)`,
    },
  };
}
test("invariants 7, 10, 11: human and standing Ops instructions emit one typed event and timeline, no Run", () => {
  const { f, state, actor, params } = instructionFixture();
  for (const author of [human, actor]) {
    const e = value(issueInstruction(state, author, params, f.io));
    expect(e.events).toMatchObject([
      {
        type: "instruction_issued",
        payload: { work_item_id: params.work_item_id },
      },
    ]);
    expect(e.timeline).toMatchObject([
      {
        type: "instruction",
        body: params.body,
        work_item_id: params.work_item_id,
      },
    ]);
    expect(e.timeline[0]?.author).toBe(
      author.kind === "human" ? "human" : "assignment:A-20",
    );
    expect(e.timeline[0]?.refs).toContainEqual({
      kind: "work_item",
      id: params.work_item_id,
    });
    expect(e.changes).toEqual([]);
    expect(e.token_requests).toEqual([]);
  }
  expect(state.runs).toEqual([]);
});
test("invariant 11: an instruction requires Ops scope, live work and matching card/project", async () => {
  const { f, state, actor, a, params } = instructionFixture();
  const reject = (
    s = state,
    who: Actor = actor,
    p = params,
    code = "forbidden_tool",
  ) =>
    expect(issueInstruction(s, who, p, f.io)).toMatchObject({
      ok: false,
      error: { code },
    });
  reject(state, f.actor(f.coder));
  reject(state, f.actor(f.pm));
  reject({
    ...state,
    assignments: [...f.state.assignments, { ...a, standing_mode: "office" }],
  });
  reject({
    ...state,
    assignments: [
      ...f.state.assignments,
      { ...a, standing_mode: undefined } as unknown as Assignment,
    ],
  });
  reject(
    state,
    { ...actor, project_id: "another-project" },
    params,
    "unauthorized",
  );
  reject(state, human, { ...params, body: " " }, "validation_failed");
  reject(
    state,
    human,
    { ...params, work_item_id: id("work_item", 999) as never },
    "not_found",
  );
  const other = mergeFixture().card;
  reject(
    { ...state, cards: [...state.cards, { ...other, id: id("card", 2) }] },
    human,
    { ...params, card_id: id("card", 2) },
    "validation_failed",
  );
  const d = await f.deliver();
  f.review(d);
  reject(
    { ...f.state, assignments: [...f.state.assignments, a] },
    human,
    params,
    "illegal_transition",
  );
  f.commit(
    updateCard(
      f.state,
      human,
      { card_id: f.card.id, status: "cancelled" },
      f.io,
    ),
  );
  reject(
    { ...f.state, assignments: [...f.state.assignments, a] },
    human,
    params,
    "illegal_transition",
  );
  expect(standingTools(role("pm").allowed_tools, "office")).not.toContain(
    "issue_instruction",
  );
  expect(standingTools(role("pm").allowed_tools, "ops")).toContain(
    "issue_instruction",
  );
});
const question = {
  category: "general" as const,
  kind: "choose" as const,
  question: "Choose",
  context: "Need direction",
  options: [{ key: "go", description: "Go", impact: "Unblocks" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human" as const,
  plain_summary: TEST_PLAIN_SUMMARY,
};
test.each([
  "general",
  "spending",
  "account",
  "permission",
  "data_deletion",
] as const)(
  "invariant 11: human records %s decisions via Needs You, preserving the quote",
  (category) => {
    const f = mergeFixture(),
      q = f.commit(
        requestDecision(
          f.state,
          human,
          { ...question, card_id: f.card.id, category },
          f.io,
        ),
      );
    const p = {
      decision_id: q.id,
      option: "go",
      rationale: "Approved",
      raw_quote: "我选 go",
    };
    const e = value(
      recordDecision(f.state, human, p, {
        ...f.io,
        human_confirmation: "workbench",
      }),
    );
    expect(e.data.resolution).toMatchObject({
      resolved_by: "human",
      via: "needs_you",
      raw_quote: p.raw_quote,
    });
    expect(e.data.status).toBe("resolved");
    expect(
      recordDecision(f.state, human, { ...p, raw_quote: "" }, f.io),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    const roleDecision = f.commit(
      requestDecision(
        f.state,
        human,
        { ...question, decider: "role:reviewer" },
        f.io,
      ),
    );
    expect(
      recordDecision(
        f.state,
        human,
        { ...p, decision_id: roleDecision.id },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  },
);

describe("invariants 9, 11: pr_url is an absolute HTTP(S) URL in both delivery phases", () => {
  test.each([
    "https://example.invalid/pull/1",
    "http://localhost/pull/2",
    "HTTPS://example.invalid/路径?q=1#part",
  ])("accepts %s", async (pr_url) => {
    const f = mergeFixture();
    f.start(f.coder);
    const p = {
      work_item_id: f.coder.work_item_id as never,
      kind: "code" as const,
      summary: "Ready",
      subject: { kind: "git_head" as const, value: "a".repeat(40) },
      requested_verifiers: [f.reviewer.work_item_id as never],
      pr_url,
    };
    const proof = value(
      await prepareDelivery(f.state, f.actor(f.coder), p, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    expect(
      value(submitDelivery(f.state, f.actor(f.coder), p, proof, f.io)).data
        .pr_url,
    ).toBe(pr_url);
  });
  test.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/example",
    "ftp://example.invalid/",
    "/pull/1",
    "//example.invalid/",
    "https://",
    "https://host:99999/",
    "https:\\evil",
    " https://example.invalid/",
    "https://example.invalid/\n",
    "",
  ])("rejects %s before IO and again at commit", async (pr_url) => {
    const f = mergeFixture();
    f.start(f.coder);
    const p = {
      work_item_id: f.coder.work_item_id as never,
      kind: "code" as const,
      summary: "Ready",
      subject: { kind: "git_head" as const, value: "a".repeat(40) },
      requested_verifiers: [f.reviewer.work_item_id as never],
    };
    let calls = 0;
    const verifier = {
      verify: async () => {
        calls++;
        return { ok: true as const, value: [] };
      },
    };
    const proof = value(
      await prepareDelivery(f.state, f.actor(f.coder), p, verifier),
    );
    expect(
      await prepareDelivery(
        f.state,
        f.actor(f.coder),
        { ...p, pr_url },
        verifier,
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(calls).toBe(1);
    expect(
      submitDelivery(f.state, f.actor(f.coder), { ...p, pr_url }, proof, f.io),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(f.state.deliveries).toEqual([]);
  });
});
test("invariant 11: number references resolve current project state; unknown numbers have no link target", async () => {
  const f = mergeFixture(),
    d = await f.deliver(),
    v = f.review(d);
  const q = f.commit(
    requestDecision(f.state, human, { ...question, card_id: f.card.id }, f.io),
  );
  const h = f.commit(
    requestHumanAction(
      f.state,
      human,
      {
        card_id: f.card.id,
        instructions: "Connect",
        why_human: "Device",
        expected_return: "Ready",
        blocked_work_items: [],
      },
      f.io,
    ),
  );
  const entry = f.state.timeline[0];
  const text = `见${f.card.id}、${f.coder.work_item_id}、${f.coder.id}、${f.state.runs[0]?.id}、${d.id}、${v.id}、${q.key}、${h.key}、${entry?.short_id}，C-999，C-999。`;
  const refs = resolveReferences(f.state, text);
  expect(refs).toHaveLength(10);
  for (const kind of [
    "card",
    "work_item",
    "assignment",
    "run",
    "delivery",
    "review",
    "decision",
    "human_action",
    "timeline_entry",
  ])
    expect(refs).toContainEqual(
      expect.objectContaining({ kind, exists: true, card_id: f.card.id }),
    );
  expect(refs.find((r) => r.id === d.id)?.status).toBe("accepted");
  expect(refs.find((r) => r.id === q.key)?.status).toBe("open");
  expect(refs.find((r) => r.id === "C-999")).toEqual({
    kind: "card",
    id: "C-999",
    status: null,
    exists: false,
  });
  expect(
    resolveReferences(f.state, "XC-1 A-01 q(01) R-9007199254740992 W-1_suffix"),
  ).toEqual([]);
  f.commit(
    recordDecision(
      f.state,
      human,
      { decision_id: q.id, option: "go", rationale: "Yes", raw_quote: "go" },
      f.io,
    ),
  );
  expect(resolveReferences(f.state, q.key)[0]?.status).toBe("resolved");
});

test("C-132: Q-n / H-n and legacy q(n) / h(n) body references resolve to the same records", async () => {
  const f = mergeFixture();
  const q = f.commit(
    requestDecision(f.state, human, { ...question, card_id: f.card.id }, f.io),
  );
  const h = f.commit(
    requestHumanAction(
      f.state,
      human,
      {
        card_id: f.card.id,
        instructions: "Connect",
        why_human: "Device",
        expected_return: "Ready",
        blocked_work_items: [],
      },
      f.io,
    ),
  );
  expect(q.key).toMatch(/^Q-[1-9][0-9]*$/u);
  expect(h.key).toMatch(/^H-[1-9][0-9]*$/u);
  const qn = q.key.slice(2),
    hn = h.key.slice(2);
  for (const text of [`${q.key} ${h.key}`, `旧写法 q(${qn})，h(${hn})。`]) {
    const refs = resolveReferences(f.state, text);
    expect(refs).toEqual([
      expect.objectContaining({ kind: "decision", id: q.key, exists: true }),
      expect.objectContaining({
        kind: "human_action",
        id: h.key,
        exists: true,
      }),
    ]);
  }
  // Both spellings in one body collapse to one reference each.
  expect(resolveReferences(f.state, `${q.key} q(${qn})`)).toHaveLength(1);
  // Malformed or embedded spellings are not references.
  expect(
    resolveReferences(
      f.state,
      `Q-0 Q-01 q(0) Q(1) XQ-${qn} H-${hn}_x q-1 Q-${qn}#2`,
    ),
  ).toEqual([]);
});
