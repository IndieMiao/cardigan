import { type Decision, requestDecision } from "@cardigan/domain";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

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
