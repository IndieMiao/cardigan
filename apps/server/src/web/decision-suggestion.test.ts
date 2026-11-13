import { requestDecision } from "@cardigan/domain";
import { expect, test } from "vitest";
import type { CardDetail, NeedsPage } from "../../../web/src/api.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

test("C-192: the human applies a suggestion over HTTP; views show it fresh and without its fingerprint", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const decision = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          // A human-only category, so it is not delegated to PM Ops.
          category: "permission",
          kind: "choose",
          question: "Grant access?",
          context: "Needed for the deploy",
          options: [
            { key: "yes", description: "授予", impact: "可以部署" },
            { key: "no", description: "不授予", impact: "继续等待" },
          ],
          recommended: "yes",
          suggestion: { option: "yes", rationale: "只读权限，风险低" },
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        p,
      ),
    );
    const needs = (await f.call(f.projectPath("/needs-you"))).json as NeedsPage;
    const listed = needs.decisions.find((q) => q.id === decision.id);
    expect(listed?.suggestion).toMatchObject({
      option: "yes",
      rationale: "只读权限，风险低",
      stale: false,
    });
    expect(listed?.suggestion).not.toHaveProperty("basis");
    const detail = (await f.call(f.projectPath(`/cards/${f.card.id}`)))
      .json as CardDetail;
    const shown = detail.decisions.find((q) => q.id === decision.id);
    expect(shown?.suggestion).toMatchObject({ option: "yes", stale: false });
    expect(shown?.suggestion).not.toHaveProperty("basis");
    const path = f.projectPath(
      `/decisions/${encodeURIComponent(decision.id)}/resolve`,
    );
    const wrong = await f.call(path, {
      method: "POST",
      body: { option: "no", via_suggestion: true },
    });
    expect(wrong.status).toBe(400);
    const resolved = await f.call(path, {
      method: "POST",
      body: { option: "yes", via_suggestion: true },
    });
    expect(resolved.status).toBe(200);
    expect(
      f.state().decisions.find((q) => q.id === decision.id)?.resolution,
    ).toMatchObject({
      option: "yes",
      resolved_by: "human",
      via: "needs_you",
      via_suggestion: true,
      raw_quote: "按建议处理：yes",
      rationale: "只读权限，风险低",
    });
  } finally {
    await f.close();
  }
}, 30_000);
