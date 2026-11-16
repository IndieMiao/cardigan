import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  submitReview,
  updateWorkItem,
} from "../index.js";
import {
  flowReviewFixture,
  required,
} from "./flow-review-limit/test-fixtures.js";
import { assignment, role } from "./test-fixtures.js";

function ops(f: ReturnType<typeof flowReviewFixture>["f"]) {
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  const owner: Assignment = {
    ...base,
    scope: "standing",
    standing_mode: "ops",
  };
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [{ collection: "assignments", entity: owner }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  return {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: owner.id,
    ...role("pm"),
  } satisfies Actor;
}

test.each([undefined, 1, 2, 3, 4, 5])(
  "B6: flow %s automatically adds rounds without configured caps; fourth consecutive reject goes to PM",
  async (version) => {
    const { f, review, reconcile } = flowReviewFixture(undefined, version);
    const pm = ops(f);
    for (let n = 0; n < 4; n++) {
      review(await f.deliver("code", (n + 1).toString().repeat(40)));
      const item = required(
        f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
      );
      expect(item.status).toBe(n < 3 ? "failed" : "waiting_decision");
      expect(f.state.decisions).toHaveLength(n < 3 ? 0 : 1);
      f.commit(reconcile());
    }
    const q = required(f.state.decisions.at(-1));
    expect(q).toMatchObject({
      trigger: "review_limit",
      decider: "role:pm",
      status: "open",
    });
    f.commit(
      updateWorkItem(
        f.state,
        pm,
        {
          work_item_id: required(f.reviewer.work_item_id),
          review_limit_decision: {
            decision_id: q.id,
            option: "raise_limit",
            rationale: "Narrowed the remaining defect",
          },
        },
        f.io,
      ),
    );
    const next = await f.deliver("code", "a".repeat(40));
    f.review(next);
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
    ).toBe("passed");
    expect(
      f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
    ).toHaveLength(3);
  },
);

test.each(["reviewer", "independent_reviewer"])(
  "B6: %s uses the same default and escalation workflow",
  async (roleId) => {
    const { f } = flowReviewFixture(null, 1);
    const pm = ops(f);
    const owner = { ...f.reviewer, role_id: roleId };
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [
          { collection: "assignments", entity: owner },
          {
            collection: "work_items",
            entity: {
              ...required(
                f.state.work_items.find((w) => w.id === owner.work_item_id),
              ),
              role_id: roleId,
            },
          },
        ],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
    // Add the role definition at the state seam; the persisted Assignment still pins its identity.
    const stateRole = role(roleId);
    for (let n = 0; n < 4; n++) {
      const v = await f.deliver("code", (n + 1).toString().repeat(40));
      f.start(owner);
      f.commit(
        submitReview(
          { ...f.state, roles: [...f.state.roles, stateRole] },
          f.actor(owner),
          {
            delivery_id: v.id,
            target_sha: v.subject.value,
            kind: "code",
            issues: [
              {
                severity: "critical",
                must_fix: true,
                pre_existing: false,
                description: "Defect",
                proof: "Reproduced",
              },
            ],
          },
          f.io,
        ),
      );
    }
    const q = required(f.state.decisions.at(-1));
    expect(q.decider).toBe("role:pm");
    f.commit(
      updateWorkItem(
        f.state,
        pm,
        {
          work_item_id: required(owner.work_item_id),
          review_limit_decision: {
            decision_id: q.id,
            option: "escalate",
            rationale: "External requirement remains unclear",
          },
        },
        f.io,
      ),
    );
    expect(f.state.decisions.at(-1)?.decider).toBe("human");
  },
);

test("B6: conditional results reset the rejection streak and consume no round", async () => {
  const { f, review } = flowReviewFixture(0, 1);
  for (let n = 0; n < 3; n++)
    review(await f.deliver("code", (n + 1).toString().repeat(40)));
  const target = await f.deliver("code", "a".repeat(40));
  review(target, false);
  expect(f.state.decisions).toEqual([]);
  const before = f.state.events.filter(
    (e) => e.type === "review_limit_raised_by_system",
  ).length;
  review(target);
  expect(f.state.decisions).toEqual([]);
  expect(
    f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
  ).toHaveLength(before + 1);
});
