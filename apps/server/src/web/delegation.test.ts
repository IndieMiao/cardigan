import {
  type Decision,
  pauseStandingAssignment,
  postComment,
  requestDecision,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import { confirmWorkbenchDecision } from "../../test-support/workbench-decision.js";

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
      (
        await history(
          `decider=human&card_id=${f.card.id}&category=scope_change`,
        )
      ).decisions.map((q) => q.id),
    ).toEqual([q.id]);
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
      .events.filter((e) => e.type === "project_preferences_updated");
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

test("cleanup fixture uses an authenticated Workbench confirmation for protected data deletion", async () => {
  const f = await m5Cross();
  try {
    const q = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          category: "data_deletion",
          kind: "choose",
          question: "清理工作目录",
          context: "未保存的修改需要人确认",
          options: [
            {
              key: "force_clean",
              description: "备份并清理",
              impact: "保存补丁后删除目录",
            },
          ],
          recommended: "force_clean",
          decider: "human",
          blocking: false,
          affected_cards: [f.card.id],
          affected_work_items: [],
        },
        p,
      ),
    );
    await confirmWorkbenchDecision({
      store: f.store(),
      dataDir: f.dataDir,
      project_id: f.project.project_id,
      decision_id: q.id,
      option: "force_clean",
    });
    expect(
      f.state().decisions.find((d) => d.id === q.id)?.resolution,
    ).toMatchObject({
      option: "force_clean",
      resolved_by: "human",
      via: "needs_you",
    });
  } finally {
    await f.close();
  }
});
