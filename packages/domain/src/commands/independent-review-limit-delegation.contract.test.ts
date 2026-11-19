import { expect, test } from "vitest";
import { setProjectPreferences } from "../index.js";
import { command } from "./core.js";
import { reconcileFlowReviewLimits } from "./flow-review-limit.js";
import { independentReviewLimitFixture } from "./independent-review-limit/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

const _system = { kind: "system" as const, project_id: human.project_id };
test.each([undefined, 1, 2, 5])(
  "Flow Lite: independent review automatically raises after rejection on flow %s",
  async (version) => {
    const { f, item, review } = independentReviewLimitFixture();
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: f.state.cards.map((c) => ({
          collection: "cards" as const,
          entity: { ...c, flow_version: version ?? 1 },
        })),
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
    const target = await f.deliver();
    review(target, true);
    expect(f.state.decisions).toEqual([]);
    expect(
      f.state.work_items.find(
        (w) =>
          w.kind === "verify" && w.id === item.id && w.max_review_rounds === 2,
      )?.kind,
    ).toBe("verify");
    const raised = f.state.events.filter(
      (e) => e.type === "review_limit_raised_by_system",
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.actor.kind).toBe("system");
    const replay = value(
      command(f.state, human, "upgrade_card_flow", f.io, (d) =>
        reconcileFlowReviewLimits(d, f.card.id),
      ),
    );
    expect(replay.events).toEqual([]);
  },
);

test.each([false, true])(
  "Flow Lite: the old delegated-review switch does not gate system raises (%s)",
  async (enabled) => {
    const { f, review, item } = independentReviewLimitFixture({
      independent_review_limit_delegation: enabled,
      independent_review_limit_delegation_max: 3,
    });
    review(await f.deliver(), true);
    expect(
      f.state.work_items.find(
        (w) =>
          w.kind === "verify" && w.id === item.id && w.max_review_rounds === 2,
      )?.kind,
    ).toBe("verify");
    expect(f.state.decisions).toEqual([]);
  },
);

test.each([0, 1, 3])(
  "B6: legacy lifetime cap %s does not block independent review before three rejections",
  async (cap) => {
    const { f, review, item } = independentReviewLimitFixture({
      system_review_limit_max_raises: cap,
    });
    for (let i = 0; i < 3; i++)
      review(await f.deliver("code", String(i + 1).repeat(40)), true);
    expect(
      f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
    ).toHaveLength(2);
    expect(f.state.work_items.find((w) => w.id === item.id)?.status).toBe(
      "waiting_decision",
    );
    expect(f.state.decisions).toMatchObject([
      { trigger: "review_limit", decider: "role:pm" },
    ]);
    expect(
      value(
        command(f.state, human, "upgrade_card_flow", f.io, (d) =>
          reconcileFlowReviewLimits(d, f.card.id),
        ),
      ).events,
    ).toEqual([]);
  },
);

test("Flow Lite: passing independent reviews do not consume rounds", async () => {
  const { f, review, item } = independentReviewLimitFixture();
  for (const sha of ["a", "b", "c", "d"])
    review(await f.deliver("code", sha.repeat(40)));
  expect(f.state.work_items.find((w) => w.id === item.id)).toMatchObject({
    status: "passed",
    max_review_rounds: 1,
  });
  expect(
    f.state.events.some((e) => e.type === "review_limit_raised_by_system"),
  ).toBe(false);
  expect(
    setProjectPreferences(
      f.state,
      f.actor(f.coder),
      { system_review_limit_max_raises: 9 },
      f.io,
    ).ok,
  ).toBe(false);
});
