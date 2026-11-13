import { expect, test } from "vitest";
import {
  assign,
  type CommandState,
  prepareDelivery,
  releaseAssignment,
  submitDelivery,
  submitReview,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

function assignItem(state: CommandState, n: number, io = ports()) {
  const item = state.work_items.find((w) => w.id === id("work_item", n));
  if (!item) throw new Error("Missing work item");
  return assign(
    state,
    human,
    { work_item_id: item.id, role_id: item.role_id },
    io,
  );
}

// assign has no parameter for moving an existing Assignment. Exercise its
// consistency guard against a stored link to somebody else's identity instead.
function borrowIdentity(state: CommandState, target: number, owner: number) {
  return {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === id("work_item", target)
        ? { ...w, assignment_id: id("assignment", owner) }
        : w,
    ),
  };
}

function expectPersistentAssignmentRejection(state: CommandState, n: number) {
  const before = JSON.stringify(state);
  expect(assignItem(state, n)).toEqual({
    ok: false,
    error: {
      code: "invariant_violation",
      message: "A work item has one persistent assignment",
    },
  });
  expect(JSON.stringify(state)).toBe(before);
}

test.each([
  [1, 2, 3],
  [2, 3, 1],
])(
  "invariant 15: assignment order %j keeps producer, reviewer and acceptance distinct even with the same role",
  (...order) => {
    const initial = fixture();
    let state: CommandState = {
      ...initial,
      assignments: [],
      runs: [],
      work_items: initial.work_items.map(
        ({ assignment_id: _unused, ...w }) => ({
          ...w,
          role_id: "pm",
        }),
      ),
    };
    const io = ports();
    const identities = new Set<string>();
    for (const n of order) {
      const assigned = value(assignItem(state, n, io));
      expect(assigned.data).toMatchObject({
        scope: "work_item",
        work_item_id: id("work_item", n),
        role_id: "pm",
      });
      identities.add(assigned.data.id);
      state = apply(state, assigned);
      const repeated = value(assignItem(state, n, io));
      expect(repeated.data.id).toBe(assigned.data.id);
      expect(repeated.changes).toEqual([]);
      expect(repeated.events).toEqual([]);
      expect(repeated.token_requests).toEqual([]);
    }
    expect(identities.size).toBe(3);
    expect(state.assignments).toHaveLength(3);
  },
);

test.each([
  { verifier: 2, released: false },
  { verifier: 2, released: true },
  { verifier: 3, released: false },
  { verifier: 3, released: true },
])(
  "invariant 15: W-$verifier cannot borrow its producer's identity (released=$released)",
  ({ verifier, released }) => {
    const initial = fixture();
    // Same roles ensure rejection is about identity ownership, not role checks.
    let state: CommandState = {
      ...initial,
      runs: [],
      assignments: initial.assignments.map((a) => ({ ...a, role_id: "pm" })),
      work_items: initial.work_items.map((w) => ({ ...w, role_id: "pm" })),
    };
    if (released) {
      state = apply(
        state,
        value(
          releaseAssignment(
            state,
            human,
            { assignment_id: id("assignment", 1) },
            ports(),
          ),
        ),
      );
      expect(
        state.assignments.find((a) => a.id === id("assignment", 1)),
      ).toMatchObject({ status: "released", work_item_id: id("work_item", 1) });
      expectPersistentAssignmentRejection(state, 1);
    }
    expectPersistentAssignmentRejection(
      borrowIdentity(state, verifier, 1),
      verifier,
    );
    // Neither an existing verifier nor a newly assigned verifier reuses it.
    expect(value(assignItem(state, verifier)).data.id).not.toBe(
      id("assignment", 1),
    );
    state = {
      ...state,
      assignments: state.assignments.filter(
        (a) => a.id !== id("assignment", verifier),
      ),
      work_items: state.work_items.map((w) => {
        if (w.id !== id("work_item", verifier)) return w;
        const { assignment_id: _unused, ...unassigned } = w;
        return unassigned;
      }),
    };
    expectPersistentAssignmentRejection(
      borrowIdentity(state, verifier, 1),
      verifier,
    );
    expect(value(assignItem(state, verifier)).data.id).not.toBe(
      id("assignment", 1),
    );
  },
);

test.each(["code", "card_completion"] as const)(
  "invariant 15: the author cannot review %s and its actual verifier cannot take over the producer",
  async (kind) => {
    const io = ports();
    let state = fixture();
    async function deliver(deliveryKind: typeof kind) {
      const params = {
        work_item_id: id("work_item", 1),
        kind: deliveryKind,
        ...(deliveryKind === "card_completion"
          ? { plain_summary: TEST_PLAIN_SUMMARY }
          : {}),
        summary: "Ready",
        subject,
        requested_verifiers: [id("work_item", deliveryKind === "code" ? 2 : 3)],
      };
      const receipt = value(
        await prepareDelivery(state, actor(), params, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      const result = value(submitDelivery(state, actor(), params, receipt, io));
      state = apply(state, result);
      return result.data;
    }
    const code = await deliver("code");
    const reviewParams = (delivery: typeof code) => ({
      delivery_id: delivery.id,
      target_sha: delivery.subject.value,
      kind: "code" as const,
      issues: [],
    });
    const codeReview = () =>
      submitReview(state, actor(2, "reviewer"), reviewParams(code), io);
    if (kind === "card_completion") state = apply(state, value(codeReview()));
    const target = kind === "code" ? code : await deliver("card_completion");
    expect(
      submitReview(state, actor(), reviewParams(target), io),
    ).toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Assignment is not a verifier for this delivery",
      },
    });
    const verifier = kind === "code" ? 2 : 3;
    const reviewed = value(
      submitReview(
        state,
        actor(verifier, verifier === 2 ? "reviewer" : "pm"),
        reviewParams(target),
        io,
      ),
    );
    state = apply(state, reviewed);
    expect(reviewed.data.verdict).toBe("pass");
    expect(reviewed.data.work_item_id).toBe(id("work_item", verifier));
    expect(
      state.runs.find((r) => r.id === reviewed.data.run_id)?.assignment_id,
    ).toBe(id("assignment", verifier));
    expectPersistentAssignmentRejection(borrowIdentity(state, 1, verifier), 1);
    expect(value(assignItem(state, 1)).data.id).toBe(id("assignment", 1));

    // Releasing a reviewer preserves its history and cannot free its identity
    // for reuse by the producer, including a completed PM acceptance review.
    state = {
      ...state,
      runs: state.runs.map((r) => ({ ...r, status: "completed" })),
    };
    state = apply(
      state,
      value(
        releaseAssignment(
          state,
          human,
          { assignment_id: id("assignment", verifier) },
          io,
        ),
      ),
    );
    expect(state.reviews).toContainEqual(reviewed.data);
    expectPersistentAssignmentRejection(borrowIdentity(state, 1, verifier), 1);
    expect(value(assignItem(state, 1)).data.id).toBe(id("assignment", 1));
  },
);
