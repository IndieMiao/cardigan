import { expect, test } from "vitest";
import type { Card, WorkItem } from "../entities.js";
import type { CommandState } from "./core.js";
import {
  prepareDelivery,
  type SubmitDeliveryParams,
  submitDelivery,
  submitReview,
} from "./delivery.js";
import { updateCard } from "./pm.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  id,
  ports,
  role,
  subject,
  value,
} from "./test-fixtures.js";

test.each(["human", "office", "ops"] as const)(
  "risk tags: %s may set, replace and clear tags with audit",
  (mode) => {
    let state = fixture();
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.scope === "standing" && mode !== "human"
          ? { ...a, standing_mode: mode }
          : a,
      ),
    };
    const caller = mode === "human" ? human : actor(4, "pm");
    const io = ports();
    let previous: Card["risk_tags"] = [];
    for (const risk_tags of [
      ["security", "permission", "numeric_rule", "security"],
      ["permission"],
      [],
    ] as const) {
      const effect = value(
        updateCard(state, caller, { card_id: card().id, risk_tags }, io),
      );
      expect(effect.data.risk_tags).toEqual([...new Set(risk_tags)]);
      expect(effect.events).toContainEqual(
        expect.objectContaining({
          type: "card_updated",
          actor: caller,
          payload: expect.objectContaining({
            previous_risk_tags: previous,
            risk_tags: effect.data.risk_tags,
          }),
        }),
      );
      state = apply(state, effect);
      previous = effect.data.risk_tags;
    }
  },
);

test.each(["coder", "independent_reviewer"])(
  "risk tags: %s cannot write even with update_card in its tool list",
  (role_id) => {
    const base = fixture();
    const state = {
      ...base,
      roles: [...base.roles, role(role_id)],
      assignments: base.assignments.map((a) =>
        a.id === id("assignment", 1) ? { ...a, role_id } : a,
      ),
    };
    for (const risk_tags of [["security"], []] as const)
      expect(
        updateCard(
          state,
          actor(1, role_id),
          { card_id: card().id, risk_tags },
          ports(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "forbidden_tool" },
      });
  },
);

test.each([
  null,
  "security",
  ["spending"],
  ["security", "concurrency"],
  [1],
  {},
])("risk tags: invalid input %j is rejected atomically", (input) => {
  const state = fixture();
  const before = JSON.stringify(state);
  expect(
    updateCard(
      state,
      human,
      {
        card_id: card().id,
        title: "Should not persist",
        risk_tags: input as Card["risk_tags"],
      },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(JSON.stringify(state)).toBe(before);
});

test("risk tags: omitted tags are preserved and cannot mix with a pre-merge check", () => {
  const state = apply(
    fixture(),
    value(
      updateCard(
        fixture(),
        human,
        {
          card_id: card().id,
          risk_tags: ["security"],
        },
        ports(),
      ),
    ),
  );
  expect(
    value(
      updateCard(
        state,
        human,
        { card_id: card().id, title: "Renamed" },
        ports(),
      ),
    ).data.risk_tags,
  ).toEqual(["security"]);
  expect(
    updateCard(
      state,
      human,
      {
        card_id: card().id,
        risk_tags: [],
        pre_merge_check: { label: "Check", status: "pending" },
      },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

const product: SubmitDeliveryParams = {
  work_item_id: id("work_item", 1),
  kind: "code",
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2)],
};
const completion: SubmitDeliveryParams = {
  ...product,
  kind: "card_completion",
  requested_verifiers: [id("work_item", 3)],
};
const verifier = { verify: async () => ({ ok: true as const, value: [] }) };

async function ready(risk_tags?: Card["risk_tags"]) {
  const io = ports();
  let state = fixture();
  if (risk_tags !== undefined)
    state = apply(
      state,
      value(updateCard(state, human, { card_id: card().id, risk_tags }, io)),
    );
  // Labels do not block ordinary product delivery or its existing code review.
  const proof = value(await prepareDelivery(state, actor(), product, verifier));
  const delivered = value(submitDelivery(state, actor(), product, proof, io));
  state = apply(state, delivered);
  state = apply(
    state,
    value(
      submitReview(
        state,
        actor(2, "reviewer"),
        {
          delivery_id: delivered.data.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        io,
      ),
    ),
  );
  return { state, io };
}

type VerifyItem = Extract<WorkItem, { kind: "verify" }>;
function withIndependent(
  state: CommandState,
  patch: Partial<VerifyItem> = {},
): CommandState {
  const item: VerifyItem = {
    id: id("work_item", 4),
    card_id: card().id,
    kind: "verify",
    role_id: "independent_reviewer",
    title: "Independent review",
    required: true,
    depends_on: [],
    completion_criteria: ["Risk reviewed"],
    status: "passed",
    target_work_item_id: product.work_item_id,
    max_review_rounds: 2,
    ...patch,
  };
  return { ...state, work_items: [...state.work_items, item] };
}

test.each([
  ["missing", null],
  ["optional", { required: false }],
  ["cancelled", { status: "cancelled" }],
  ["other card", { card_id: id("card", 2) }],
  ["other role", { role_id: "reviewer" }],
  ["replaced", { replaced_by_work_item_id: id("work_item", 5) }],
] as const)(
  "risk tags: %s review cannot satisfy the hard completion gate",
  async (_label, patch) => {
    const { state: initial } = await ready(["security"]);
    const state = patch === null ? initial : withIndependent(initial, patch);
    const result = await prepareDelivery(
      state,
      actor(),
      {
        ...completion,
        known_gaps: [
          {
            description: "Review later",
            followup_card_id: card(2).id,
            precondition: "work_item:W-4",
          },
        ],
      },
      verifier,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invariant_violation",
        message: expect.stringContaining("必需且未取消"),
      },
    });
    expect(state.deliveries.some((d) => d.kind === "card_completion")).toBe(
      false,
    );
  },
);

test("risk tags: a produce item named independent_reviewer is not verification", async () => {
  const { state } = await ready(["numeric_rule"]);
  const result = await prepareDelivery(
    {
      ...state,
      work_items: [
        ...state.work_items,
        {
          id: id("work_item", 4),
          card_id: card().id,
          title: "Not a review",
          role_id: "independent_reviewer",
          required: true,
          depends_on: [],
          completion_criteria: [],
          kind: "produce",
          status: "accepted",
        },
      ],
    },
    actor(),
    completion,
    verifier,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("独立复核验证项") },
  });
});

test("risk tags: adding a required review preserves existing completion preconditions", async () => {
  const { state: initial, io } = await ready(["permission"]);
  for (const status of ["todo", "passed"] as const) {
    const state = withIndependent(initial, { status });
    const proof = value(
      await prepareDelivery(state, actor(), completion, verifier),
    );
    const result = submitDelivery(state, actor(), completion, proof, io);
    if (status === "todo")
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "invariant_violation",
          message: "Known gap with follow-up card required: work_item:W-4",
        },
      });
    else
      expect(result).toMatchObject({
        ok: true,
        value: { data: { kind: "card_completion" } },
      });
  }
});

test.each([undefined, []] as const)(
  "risk tags: untagged legacy cards still complete (%j)",
  async (tags) => {
    const { state, io } = await ready(tags);
    const proof = value(
      await prepareDelivery(state, actor(), completion, verifier),
    );
    expect(submitDelivery(state, actor(), completion, proof, io).ok).toBe(true);
  },
);

test("risk tags: submission rechecks labels and verification against the fresh transaction", async () => {
  const { state: initial, io } = await ready();
  const proof = value(
    await prepareDelivery(initial, actor(), completion, verifier),
  );
  const tagged = apply(
    initial,
    value(
      updateCard(
        initial,
        human,
        { card_id: card().id, risk_tags: ["security"] },
        io,
      ),
    ),
  );
  const before = JSON.stringify(tagged);
  expect(submitDelivery(tagged, actor(), completion, proof, io)).toMatchObject({
    ok: false,
    error: {
      code: "invariant_violation",
      message: expect.stringContaining("独立复核验证项"),
    },
  });
  expect(JSON.stringify(tagged)).toBe(before);
});
