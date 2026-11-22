import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  assign,
  createCard,
  createWorkItem,
  finishRun,
  hasRunTarget,
  issueInstruction,
  postComment,
  queueRun,
  refreshTestReviewLimits,
  releaseAssignment,
  replaceVerificationWorkItem,
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
                impact: "functional" as const,
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
  parallel = false,
) {
  const { f, review } = flowReviewFixture();
  const pm = ops(f);
  let peer: Assignment | undefined;
  if (parallel) {
    const item = f.commit(
      createWorkItem(
        f.state,
        pm,
        {
          card_id: f.card.id,
          kind: "verify",
          role_id: "reviewer",
          required: true,
          title: "Second review",
          completion_criteria: ["Works"],
          max_review_rounds: 1,
          target_work_item_id: required(f.coder.work_item_id),
        },
        f.io,
      ),
    );
    peer = f.commit(
      assign(
        f.state,
        human,
        { work_item_id: item.id, role_id: item.role_id },
        f.io,
      ),
    );
  }
  for (const [i, category] of categories.entries()) {
    const target = await f.deliver("code", String(i + 1).repeat(40));
    for (const reviewer of peer ? [f.reviewer, peer] : [f.reviewer])
      review(
        target,
        true,
        category,
        ["权限未校验", "旧快照写回", "写入顺序错误"][i],
        reviewer,
      );
  }
  const q = required(
    f.state.decisions.find(
      (q) => q.affected_work_items[0] === f.reviewer.work_item_id,
    ),
  );
  const resolve = (
    option: ReviewLimitResolution["option"],
    rationale = "导出功能本轮不做",
    decision = q,
    pausePlan: ReviewLimitResolution["pause_plan"] | null = {
      owner: f.coder.id,
      confirmers: peer ? [f.reviewer.id, peer.id] : [f.reviewer.id],
      next_step: "提交状态与证据表",
    },
  ) =>
    updateWorkItem(
      f.state,
      pm,
      {
        work_item_id: required(decision.affected_work_items[0]),
        review_limit_decision: {
          decision_id: decision.id,
          option,
          rationale,
          ...(option === "pause" && pausePlan ? { pause_plan: pausePlan } : {}),
        },
      },
      f.io,
    );
  const comment = (
    owner: Assignment,
    step: "propose" | "confirm",
    reply_to?: TimelineEntryId,
    decision = q,
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
        review_plan: { decision_id: decision.id, step },
        ...(reply_to ? { reply_to } : {}),
      },
      f.io,
    );
  return { f, q, resolve, comment, peer };
}

test("third reject lists the verifier's three causes and recommends an alternative only for adjacent matching causes", async () => {
  const { q } = await intervention([undefined, undefined, undefined]);
  for (const [reason, category] of [
    ["权限未校验", "权限边界"],
    ["旧快照写回", "并发时序"],
    ["写入顺序错误", "并发时序"],
  ])
    expect(q.context).toContain(`【${category}】${reason}`);
  expect(q.context).toContain("影响程度：功能错误");
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
  const { f, q, resolve, comment } = await intervention();
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
  // Neither side can withdraw a bound agreement through plain supersession.
  for (const [owner, entry] of [
    [f.coder, updated],
    [f.reviewer, confirmed],
  ] as const) {
    const withdraw = postComment(
      f.state,
      f.actor(owner),
      { card_id: f.card.id, body: "撤回，需再审", supersedes: entry.id },
      f.io,
    );
    expect(withdraw).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  }
  expect(f.state.reviews).toHaveLength(3);
  expect((await f.deliver("code", "a".repeat(40))).status).toBe("submitted");
});

test.each([true, false])(
  "replacing a verifier transfers only the plan obligation (proposed before replacement: %s)",
  async (before) => {
    const { f, q, resolve, comment } = await intervention();
    f.commit(resolve("change_approach"));
    const first = before
      ? required(f.commit(comment(f.coder, "propose")))
      : undefined;
    const old = required(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
    );
    const outdated = required(f.state.deliveries.at(-1));
    f.start(f.reviewer);
    const run = required(
      f.state.runs.find(
        (r) => r.assignment_id === f.reviewer.id && r.status === "running",
      ),
    );
    f.commit(
      finishRun(
        f.state,
        f.actor(f.reviewer),
        { run_id: run.id, outcome: "completed", summary: "handoff" },
        f.io,
      ),
    );
    f.commit(
      releaseAssignment(f.state, human, { assignment_id: f.reviewer.id }, f.io),
    );
    const next = f.commit(
      replaceVerificationWorkItem(
        f.state,
        human,
        {
          card_id: f.card.id,
          work_item_id: old.id,
          template_key: required(old.template_key),
          reason: "接手审核",
        },
        f.io,
      ),
    );
    const reviewer = f.commit(
      assign(
        f.state,
        human,
        { work_item_id: next.id, role_id: next.role_id },
        f.io,
      ),
    );
    expect(f.state.deliveries.find((v) => v.id === outdated.id)?.status).toBe(
      "superseded",
    );
    expect(hasRunTarget(reviewer, f.state)).toBe(before);
    const proposal = first ?? required(f.commit(comment(f.coder, "propose")));
    expect(
      f.state.timeline.findLast(
        (e) => e.type === "instruction" && e.work_item_id === next.id,
      )?.body,
    ).toContain(proposal.id);
    f.start(reviewer);
    await expect(f.deliver()).rejects.toThrow(q.id);
    expect(comment(f.reviewer, "confirm", proposal.id).ok).toBe(false);
    expect(comment(f.pm, "confirm", proposal.id).ok).toBe(false);
    f.commit(comment(reviewer, "confirm", proposal.id));
    expect(hasRunTarget(reviewer, f.state)).toBe(false);
    expect(
      submitReview(
        f.state,
        f.actor(reviewer),
        {
          delivery_id: outdated.id,
          target_sha: outdated.subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ).ok,
    ).toBe(false);
    expect(f.state.reviews).toHaveLength(3);
    const delivered = await f.deliver();
    expect(delivered.requested_verifiers).toEqual([next.id]);
    expect(hasRunTarget(reviewer, f.state)).toBe(true);
  },
);

test("parallel plan decisions retain partial confirmation and issue exactly one start instruction after the last", async () => {
  const { f, q, peer, comment, resolve } = await intervention(undefined, true);
  const other = required(
    f.state.decisions.find(
      (it) => it.affected_work_items[0] === peer?.work_item_id,
    ),
  );
  for (const decision of [q, other])
    f.commit(resolve("change_approach", "改用版本校验", decision));
  const a = required(f.commit(comment(f.coder, "propose")));
  const b = required(f.commit(comment(f.coder, "propose", undefined, other)));
  const authorInstructions = () =>
    f.state.timeline.filter(
      (t) =>
        t.type === "instruction" && t.work_item_id === f.coder.work_item_id,
    );
  const initial = authorInstructions().length;
  const ack = required(f.commit(comment(f.reviewer, "confirm", a.id)));
  expect(
    f.state.decisions.find((d) => d.id === q.id)?.review_intervention
      ?.confirmation,
  ).toBe(ack.id);
  expect(authorInstructions()).toHaveLength(initial);
  expect(comment(f.reviewer, "confirm", b.id, other).ok).toBe(false);
  await expect(f.deliver()).rejects.toThrow(other.id);
  f.commit(comment(required(peer), "confirm", b.id, other));
  expect(authorInstructions()).toHaveLength(initial + 1);
  expect(authorInstructions().at(-1)?.body).toContain("修改并重新交付");
  expect((await f.deliver()).status).toBe("submitted");
});

test("provisional review: refuse initial before enqueue, dispatch only the directed discussion and preserve the formal wait", async () => {
  const { f, resolve } = await intervention();
  f.commit(resolve("pause"));
  const owner = f.reviewer,
    id = required(owner.work_item_id);
  const first = {
    assignment_id: owner.id,
    model: "fixture",
    agent_cli_version: "1",
  };
  expect(queueRun(f.state, human, first, f.io)).toMatchObject({
    ok: false,
    error: { message: "Review budget is waiting for a decision" },
  });
  const instruct = (work_item_id: typeof id) => {
    f.commit(
      issueInstruction(
        f.state,
        human,
        { work_item_id, card_id: f.card.id, body: "请核对方案" },
        f.io,
      ),
    );
    return required(f.state.events.at(-1)).id;
  };
  const other = instruct(required(f.coder.work_item_id));
  expect(
    queueRun(f.state, human, { ...first, trigger_event_id: other }, f.io).ok,
  ).toBe(false);
  const trigger = instruct(id);
  const run = f.commit(
    queueRun(f.state, human, { ...first, trigger_event_id: trigger }, f.io),
  );
  f.start(owner);
  f.commit(
    refreshTestReviewLimits(
      f.state,
      { kind: "system", project_id: f.state.project_id },
      f.io,
    ),
  );
  expect(f.state.runs.find((r) => r.id === run.id)?.status).toBe("running");
  expect(f.state.work_items.find((w) => w.id === id)?.status).toBe(
    "waiting_decision",
  );
  const t = required(f.state.deliveries.at(-1));
  expect(
    submitReview(
      f.state,
      f.actor(owner),
      {
        delivery_id: t.id,
        target_sha: t.subject.value,
        kind: "code",
        issues: [],
        recheck_required: false,
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(f.state.decisions.at(-1)?.status).toBe("provisional");
});

test("settlement retires an old unstarted initial created inside this review wait", async () => {
  const { f, resolve, comment } = await intervention();
  f.commit(resolve("pause"));
  const proposal = required(f.commit(comment(f.coder, "propose")));
  f.commit(comment(f.reviewer, "confirm", proposal.id));
  // Model the previous CLI's two-transaction start, without changing the real waiting item.
  const former = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === f.reviewer.work_item_id ? { ...w, status: "ready" as const } : w,
    ),
  };
  const run = f.commit(
    queueRun(
      former,
      human,
      {
        assignment_id: f.reviewer.id,
        model: "fixture",
        agent_cli_version: "1",
      },
      f.io,
    ),
  );
  f.commit(resolve("change_approach"));
  expect(f.state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(
    f.state.events.filter(
      (e) =>
        e.type === "run_dispatch_aborted" &&
        (e.payload as { run_id?: string }).run_id === run.id,
    ),
  ).toHaveLength(1);
});
