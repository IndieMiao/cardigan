import {
  type Decision,
  type HumanAction,
  pauseStandingAssignment,
  postComment,
  requestDecision,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

test("Workbench answers and grants atomically, enforces fixed risks and filters human/PM history", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const make = (category: "scope_change" | "general" | "permission") =>
      f.command((s, a, p) =>
        requestDecision(
          s,
          a,
          {
            card_id: f.card.id,
            category,
            kind: "choose",
            question: "如何继续",
            context: "已明确选项",
            options: [{ key: "go", description: "继续", impact: "推进当前卡" }],
            recommended: "go",
            decider: "human",
            plain_summary: TEST_PLAIN_SUMMARY,
            affected_cards: [f.card.id],
            affected_work_items: [],
            blocking: false,
          },
          p,
        ),
      );
    const q = make("scope_change");
    const resolve = (decision: Decision, key: string, body: object) =>
      f.call(
        f.projectPath(`/decisions/${encodeURIComponent(decision.id)}/resolve`),
        { method: "POST", headers: { "idempotency-key": key }, body },
      );
    expect(
      (
        await resolve(q, "invalid", {
          option: "missing",
          delegate_future: true,
        })
      ).status,
    ).toBe(400);
    expect((await f.call(f.projectPath("/preferences"))).json).toMatchObject({
      decision_delegation: { scope_change: false },
    });
    const answer = await resolve(q, "grant", {
      option: "go",
      delegate_future: true,
    });
    expect(answer.status).toBe(200);
    expect(
      (await resolve(q, "grant", { option: "go", delegate_future: true })).json,
    ).toEqual(answer.json);
    expect((await f.call(f.projectPath("/preferences"))).json).toMatchObject({
      decision_delegation: { scope_change: true },
    });
    const next = make("scope_change");
    expect(next.decider).toBe("role:pm");
    const ops = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing PM Ops");
    await f.start(ops);
    await f.mcp(ops, "resolve_delegated_decision", {
      decision_id: next.id,
      option: "go",
      rationale: "依据人刚授予的类别权限",
    });
    const risk = make("permission");
    expect(
      (
        await resolve(risk, "risk-grant", {
          option: "go",
          delegate_future: true,
        })
      ).status,
    ).toBe(403);
    expect(f.state().decisions.find((q) => q.id === risk.id)?.status).toBe(
      "open",
    );
    expect((await resolve(risk, "risk-answer", { option: "go" })).status).toBe(
      200,
    );
    expect(
      (
        await f.call(f.projectPath("/preferences"), {
          method: "POST",
          headers: { "idempotency-key": "forbidden" },
          body: { decision_delegation: { spending: true } },
        })
      ).status,
    ).toBe(403);
    const history = async (query: string) =>
      (await f.call(f.projectPath(`/decision-history?${query}`))).json as {
        decisions: Decision[];
      };
    expect(
      (await history("decider=pm&category=scope_change")).decisions.map(
        (q) => q.id,
      ),
    ).toEqual([next.id]);
    expect(
      (await history("decider=pm")).decisions[0]?.resolution,
    ).toMatchObject({
      resolved_by: `assignment:${ops.id}`,
      author_display: "PM 后台（PM Ops）",
    });
    expect(
      (
        await history(
          `decider=human&card_id=${f.card.id}&category=scope_change`,
        )
      ).decisions.map((q) => q.id),
    ).toEqual([q.id]);
    expect(
      (await history("decider=human")).decisions[0]?.resolution,
    ).toMatchObject({
      resolved_by: "human",
      author_display: "所有者",
      member: { id: "M-1", name: "所有者", title: "所有者", avatar: null },
    });
    expect((await history("decider=system")).decisions).toEqual([]);
    expect((await history("from=2099-01-01T00:00:00Z")).decisions).toEqual([]);
    expect((await history("card_id=C-999")).decisions).toEqual([]);
    expect(
      (await f.call(f.projectPath("/decision-history?from=bad"))).status,
    ).toBe(400);
    expect(
      (await f.call(f.projectPath("/decision-history"), { anonymous: true }))
        .status,
    ).toBe(401);
    const grants = f
      .state()
      .events.filter(
        (e) =>
          e.type === "project_preferences_updated" &&
          (e.payload as { preference?: string }).preference ===
            "decision_delegation",
      );
    expect(grants).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("unclaimed completed decisions stay visible in Workbench and CLI without allowing a second answer", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    await f.start(f.primary.owner);
    const q = await f.mcp<Decision>(f.primary.owner, "request_decision", {
      card_id: f.card.id,
      category: "scope_change",
      kind: "choose",
      question: "是否扩大范围",
      context: "需要确认",
      options: [
        { key: "go", description: "安排后续卡", impact: "建立下一阶段工作" },
      ],
      recommended: "go",
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      blocking: false,
      affected_cards: [f.card.id],
      affected_work_items: [],
    });
    await f.finish(f.primary.owner);
    f.release(f.primary.owner);
    const ops = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing Ops");
    f.command((s, a, p) =>
      pauseStandingAssignment(s, a, { assignment_id: ops.id }, p),
    );
    expect(
      (
        await f.call(
          f.projectPath(`/decisions/${encodeURIComponent(q.id)}/resolve`),
          { method: "POST", body: { option: "go" } },
        )
      ).status,
    ).toBe(200);
    const before = f.state();
    expect((await f.call(f.projectPath("/needs-you"))).json).toMatchObject({
      decisions: [
        {
          id: q.id,
          status: "resolved",
          followup_notice: expect.any(String),
          resolution: { option: "go" },
        },
      ],
    });
    expect(await f.cli("needs-you")).toContain("拍板落实（1）");
    expect(f.state()).toEqual(before);
    expect(
      (
        await f.call(
          f.projectPath(`/decisions/${encodeURIComponent(q.id)}/resolve`),
          { method: "POST", body: { option: "go" } },
        )
      ).status,
    ).toBe(409);
    f.command((s, a, p) =>
      postComment(
        s,
        a,
        { card_id: f.card.id, body: `${q.id} 执行结果：已经建立后续卡` },
        p,
      ),
    );
    expect((await f.call(f.projectPath("/needs-you"))).json).toMatchObject({
      decisions: [],
    });
  } finally {
    await f.close();
  }
});

test("PM handoff copy persists through MCP, Workbench and CLI without replacing the request", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    await f.start(f.primary.owner);
    const original = {
      card_id: f.card.id,
      instructions: "submit_delivery(kind=card_completion) needs repository",
      why_human: "repository unavailable",
      expected_return: "SHA",
      blocked_work_items: [],
    };
    const action = await f.mcp<HumanAction>(
      f.primary.owner,
      "request_human_action",
      original,
    );
    const ops = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing PM Ops");
    await f.start(ops);
    const handoff = {
      human_action_id: action.id,
      disposition: "host",
      rationale: "开发者需要主机上的最新副本",
      title: "请把最新项目代码同步给开发者",
      summary: "开发任务正在等待最新的项目代码。",
      why_human: "只有你能访问主机上的仓库凭据。",
      instructions: "在主机终端同步代码，把最新版本号发回这张卡片。",
      expected_outcome: "开发者将能继续完成修改。",
      expected_return: "最新版本号",
    };
    const invalid = await f.raw(ops, "triage_human_action", {
      ...handoff,
      summary: " ",
    });
    expect(invalid.isError).toBe(true);
    expect(
      f.state().human_actions.find((h) => h.id === action.id)?.handoff,
    ).toBeUndefined();
    const result = await f.mcp<HumanAction>(ops, "triage_human_action", {
      ...handoff,
      rewritten_by: "human",
    });
    expect(result).toMatchObject({
      instructions: original.instructions,
      expected_return: original.expected_return,
      handoff: { title: handoff.title, rewritten_by: `assignment:${ops.id}` },
    });
    const needs = await f.call(f.projectPath("/needs-you"));
    expect(needs.json).toMatchObject({
      human_actions: [
        {
          id: action.id,
          handoff: {
            title: handoff.title,
            summary: handoff.summary,
            why_human: handoff.why_human,
            expected_outcome: handoff.expected_outcome,
          },
          instructions: handoff.instructions,
          expected_return: handoff.expected_return,
          original_request: {
            instructions: original.instructions,
            why_human: original.why_human,
            expected_return: original.expected_return,
          },
        },
      ],
    });
    const cli = await f.cli("needs-you");
    expect(cli).toContain(`${handoff.title}（项目经理已改写）`);
    expect(cli).toContain(handoff.expected_outcome);
    expect(cli).not.toContain("submit_delivery(kind=card_completion)");
    const done = await f.raw(ops, "triage_human_action", {
      human_action_id: action.id,
      disposition: "done",
      rationale: "交给人之后不能代为确认",
    });
    expect(done.isError).toBe(true);
    expect(
      f.state().human_actions.find((h) => h.id === action.id)?.status,
    ).toBe("open");
  } finally {
    await f.close();
  }
});

test("PM merge confirmation setting round-trips and delegated answers become readable notices", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    // The shared fixture covers the human merge path, so it starts switched off.
    expect((await f.call(f.projectPath("/preferences"))).json).toMatchObject({
      pm_merge_confirmation: false,
    });
    const set = await f.call(f.projectPath("/preferences"), {
      method: "POST",
      headers: { "idempotency-key": "pm-merge-on" },
      body: { pm_merge_confirmation: true },
    });
    expect(set.status).toBe(200);
    expect((await f.call(f.projectPath("/preferences"))).json).toMatchObject({
      pm_merge_confirmation: true,
    });
    expect(
      (
        await f.call(f.projectPath("/preferences"), {
          method: "POST",
          headers: { "idempotency-key": "pm-merge-bad" },
          body: { pm_merge_confirmation: "yes" },
        })
      ).status,
    ).toBe(400);
    const q = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          category: "general",
          kind: "choose",
          question: "流程如何处理",
          context: "已明确选项",
          options: [{ key: "go", description: "继续", impact: "推进当前卡" }],
          recommended: "go",
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
          affected_cards: [f.card.id],
          affected_work_items: [],
          blocking: false,
        },
        p,
      ),
    );
    expect(q.decider).toBe("role:pm");
    const ops = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing PM Ops");
    await f.start(ops);
    await f.mcp(ops, "resolve_delegated_decision", {
      decision_id: q.id,
      option: "go",
      rationale: "流程类，按惯例处理",
    });
    const needs = (await f.call(f.projectPath("/needs-you"))).json as {
      notices: {
        id: string;
        decision_id: string;
        body: string;
        read: boolean;
      }[];
      counts: { notices_unread: number };
    };
    expect(needs.notices).toMatchObject([
      {
        decision_id: q.id,
        body: "继续。理由：流程类，按惯例处理",
        read: false,
        author_display: "PM 后台（PM Ops）",
      },
    ]);
    expect(needs.counts.notices_unread).toBe(1);
    const notice = needs.notices[0]?.id ?? "";
    expect(
      (
        await f.call(f.projectPath("/notices/read"), {
          method: "POST",
          body: { notice_ids: [notice] },
          anonymous: true,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.call(f.projectPath("/notices/read"), {
          method: "POST",
          body: { notice_ids: [notice] },
        })
      ).status,
    ).toBe(200);
    expect((await f.call(f.projectPath("/needs-you"))).json).toMatchObject({
      notices: [{ id: notice, read: true }],
      counts: { notices_unread: 0 },
    });
  } finally {
    await f.close();
  }
});
