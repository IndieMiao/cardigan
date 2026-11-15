import {
  postComment,
  requestDecision,
  resolveDelegatedDecision,
  updateCard,
} from "@cardigan/domain";
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
    f.command((s, a, p) =>
      postComment(
        s,
        a,
        { card_id: f.card.id, body: "补充证据：偶发失败，可以重查" },
        p,
      ),
    );
    const updated = (await f.call(f.projectPath("/needs-you")))
      .json as NeedsPage;
    const progress = updated.decisions.find((q) => q.id === decision.id)
      ?.suggestion?.progress;
    expect(progress?.count).toBe(1);
    expect(progress?.entries[0]?.summary).toContain("偶发失败");
    const paged = (
      await f.call(f.projectPath(`/cards/${f.card.id}?limit=1&type=system`))
    ).json as CardDetail;
    expect(
      paged.decisions.find((q) => q.id === decision.id)?.suggestion?.progress,
    ).toEqual(progress);
    const unconfirmed = await f.call(path, {
      method: "POST",
      body: {
        option: "yes",
        via_suggestion: true,
        suggestion_version: shown?.suggestion?.version,
      },
    });
    expect(unconfirmed.status).toBe(409);
    const resolved = await f.call(path, {
      method: "POST",
      body: {
        option: "yes",
        via_suggestion: true,
        suggestion_progress_token: progress?.token,
        suggestion_version: shown?.suggestion?.version,
      },
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

test("C-303: HTTP apply binds the displayed suggestion through same-option reason, soft and hard refreshes", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const q = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          category: "permission",
          kind: "choose",
          question: "核对合成证据",
          context: "合成数据",
          decider: "human",
          blocking: false,
          options: [{ key: "yes", description: "继续", impact: "继续" }],
          recommended: "yes",
          suggestion: { option: "yes", rationale: "原建议" },
          affected_cards: [],
          affected_work_items: [],
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        p,
      ),
    );
    const path = f.projectPath(`/decisions/${q.id}/resolve`);
    const read = async () => {
      const needs = (await f.call(f.projectPath("/needs-you")))
        .json as NeedsPage;
      const advice = needs.decisions.find((d) => d.id === q.id)?.suggestion;
      if (!advice) throw new Error("Missing suggestion");
      const detail = (await f.call(f.projectPath(`/cards/${f.card.id}`)))
        .json as CardDetail;
      expect(detail.decisions.find((d) => d.id === q.id)?.suggestion).toEqual(
        advice,
      );
      return advice;
    };
    const payload = (version?: number) => ({
      option: "yes",
      via_suggestion: true,
      suggestion_version: version,
    });
    const post = (body: unknown) => f.call(path, { method: "POST", body });
    expect((await post(payload())).status).toBe(409);
    for (const change of ["reason", "soft", "hard"]) {
      const old = await read();
      if (change === "soft")
        f.command((s, a, p) =>
          postComment(s, a, { card_id: f.card.id, body: "新证据" }, p),
        );
      if (change === "hard")
        f.command((s, a, p) =>
          updateCard(
            s,
            a,
            {
              card_id: f.card.id,
              pre_merge_check: { label: "合成核对", status: "pending" },
            },
            p,
          ),
        );
      if (change !== "reason")
        expect((await post(payload(old.version))).status).toBe(409);
      f.command((s, _a, p) => {
        const ops = s.assignments.find(
          (a) =>
            a.scope === "standing" &&
            a.standing_mode === "ops" &&
            a.status === "active",
        );
        const role = s.roles.find(
          (r) =>
            r.role_id === ops?.role_id && r.role_version === ops.role_version,
        );
        if (!ops || !role) throw new Error("Missing fixture Ops");
        return resolveDelegatedDecision(
          s,
          {
            kind: "assignment",
            project_id: s.project_id,
            assignment_id: ops.id,
            role_id: ops.role_id,
            role_version: ops.role_version,
            allowed_tools: role.allowed_tools,
            capabilities: role.capabilities,
          },
          {
            decision_id: q.id,
            option: "yes",
            rationale: "已复核",
            escalate: true,
            suggestion: { option: "yes", rationale: `新建议：${change}` },
          },
          p,
        );
      });
      const current = await read();
      expect(current.version).toBe(old.version + 1);
      expect(current.stale).toBe(false);
      expect(current.progress).toBeUndefined();
      expect((await post(payload(old.version))).status).toBe(409);
      expect((await post(payload())).status).toBe(409);
      expect(
        f.state().decisions.find((d) => d.id === q.id)?.resolution,
      ).toBeUndefined();
    }
    const current = await read();
    expect((await post(payload(current.version))).status).toBe(200);
    expect(
      f.state().decisions.find((d) => d.id === q.id)?.resolution,
    ).toMatchObject({
      resolved_by: "human",
      via_suggestion: true,
      rationale: current.rationale,
    });
  } finally {
    await f.close();
  }
}, 30_000);
