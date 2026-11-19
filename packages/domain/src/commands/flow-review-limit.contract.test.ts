import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  createCard,
  postComment,
  submitReview,
  type TimelineEntryId,
  updateWorkItem,
} from "../index.js";
import {
  flowReviewFixture,
  required,
} from "./flow-review-limit/test-fixtures.js";
import type { ReviewLimitResolution } from "./review-limit-resolution.js";
import { assignment, human, role } from "./test-fixtures.js";

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
  "B6: flow %s automatically adds rounds without configured caps; third consecutive reject goes to PM",
  async (version) => {
    const { f, review, reconcile } = flowReviewFixture(undefined, version);
    const pm = ops(f);
    for (let n = 0; n < 3; n++) {
      review(await f.deliver("code", (n + 1).toString().repeat(40)));
      const item = required(
        f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
      );
      expect(item.status).toBe(n < 2 ? "failed" : "waiting_decision");
      expect(f.state.decisions).toHaveLength(n < 2 ? 0 : 1);
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
    ).toHaveLength(2);
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
    for (let n = 0; n < 3; n++) {
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
  for (let n = 0; n < 2; n++)
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

async function intervention(
  categories: (string | undefined)[] = ["权限", "时序", "时序"],
) {
  const { f, review } = flowReviewFixture();
  const pm = ops(f);
  for (const [i, category] of categories.entries()) {
    review(
      await f.deliver("code", String(i + 1).repeat(40)),
      true,
      category,
      ["权限未校验", "旧快照写回", "写入顺序错误"][i],
    );
  }
  const q = required(f.state.decisions.at(-1));
  const id = required(f.reviewer.work_item_id);
  const resolve = (
    option: ReviewLimitResolution["option"],
    rationale = "导出功能本轮不做",
  ) =>
    updateWorkItem(
      f.state,
      pm,
      {
        work_item_id: id,
        review_limit_decision: { decision_id: q.id, option, rationale },
      },
      f.io,
    );
  return { f, q, resolve };
}

test("third reject lists the verifier's three causes and recommends an alternative only for adjacent matching causes", async () => {
  const { q } = await intervention([undefined, undefined, undefined]);
  for (const [reason, category] of [
    ["权限未校验", "权限边界"],
    ["旧快照写回", "并发时序"],
    ["写入顺序错误", "并发时序"],
  ])
    expect(q.context).toContain(`【${category}】${reason}`);
  expect(q.recommended).toBe("change_approach");
  expect(q.options.map((o) => o.key)).toEqual([
    "raise_limit",
    "pause",
    "change_approach",
    "narrow_scope",
    "split_card",
  ]);
  const mixed = await intervention(["时序", "权限", "时序"]);
  expect(mixed.q.options.map((o) => o.key)).toEqual(["raise_limit", "pause"]);
  expect(mixed.resolve("change_approach").ok).toBe(false);
});

test.each(["narrow_scope", "split_card"] as const)(
  "%s binds the remaining work without passing review",
  async (option) => {
    const { f, q, resolve } = await intervention();
    if (option === "split_card") {
      expect(resolve(option).ok).toBe(false);
      const followup = f.commit(
        createCard(
          f.state,
          human,
          {
            title: "导出",
            goal: "完成导出",
            acceptance_criteria: ["可以导出"],
            source: { kind: "decision", decision_id: q.id },
            repo: "fixture",
            base_branch: "main",
          },
          f.io,
        ),
      );
      f.commit(resolve(option));
      expect(
        f.state.cards.find((c) => c.id === f.card.id)?.related_cards,
      ).toContain(followup.id);
    } else f.commit(resolve(option));
    expect(
      f.state.cards.find((c) => c.id === f.card.id)?.out_of_scope.join(" "),
    ).toContain("导出功能本轮不做");
    expect(f.state.deliveries.at(-1)?.status).toBe("rejected");
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
    ).toBe("ready");
    expect(f.state.decisions.find((d) => d.id === q.id)?.status).toBe(
      "resolved",
    );
    expect(resolve(option).ok).toBe(false);
  },
);

test("change approach requires the author's proposal and the designated verifier's confirmation of that exact revision", async () => {
  const { f, q, resolve } = await intervention();
  const comment = (
    owner: Assignment,
    step: "propose" | "confirm",
    reply_to?: TimelineEntryId,
  ) =>
    postComment(
      f.state,
      f.actor(owner),
      {
        card_id: f.card.id,
        body:
          step === "propose"
            ? "写入带版本号，旧快照不覆盖新值"
            : "同意用版本校验",
        review_plan: { decision_id: q.id, step },
        ...(reply_to ? { reply_to } : {}),
      },
      f.io,
    );
  f.commit(resolve("change_approach"));
  expect(
    f.state.timeline.findLast((e) => e.type === "instruction"),
  ).toMatchObject({ work_item_id: f.coder.work_item_id, decision_id: q.id });
  await expect(f.deliver("code", "a".repeat(40))).rejects.toThrow(
    "确认方案方向",
  );
  expect(comment(f.reviewer, "propose").ok).toBe(false);
  expect(comment(f.reviewer, "confirm").ok).toBe(false);
  const first = required(f.commit(comment(f.coder, "propose")));
  const updated = required(f.commit(comment(f.coder, "propose")));
  expect(comment(f.coder, "confirm", updated.id).ok).toBe(false);
  expect(comment(f.pm, "confirm", updated.id).ok).toBe(false);
  expect(comment(f.reviewer, "confirm", first.id).ok).toBe(false);
  await expect(f.deliver("code", "a".repeat(40))).rejects.toThrow(
    "确认方案方向",
  );
  const confirmed = required(
    f.commit(comment(f.reviewer, "confirm", updated.id)),
  );
  expect(f.state.decisions.at(-1)?.review_intervention).toMatchObject({
    proposal: updated.id,
    confirmation: confirmed.id,
  });
  expect(comment(f.reviewer, "confirm", updated.id).ok).toBe(false);
  expect(f.state.reviews).toHaveLength(3);
  expect((await f.deliver("code", "a".repeat(40))).status).toBe("submitted");
});
