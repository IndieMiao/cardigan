import { createProcessIo, main } from "@cardigan/cli";
import {
  type Decision,
  type DeliveryId,
  type HumanAction,
  mergePlan,
  pauseStandingAssignment,
  postComment,
  prepareMergePlan,
  recordMergeCheck,
  requestDecision,
} from "@cardigan/domain";
import { CentralGitTransport } from "@cardigan/git-transport";
import { expect, onTestFinished, test, vi } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import { MergeChecks } from "../merge-checks.js";
import { MergeExecutor } from "../merge-loop.js";
import { withPublication } from "../publication-lock.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

test.each([
  "spending",
  "account",
  "data_deletion",
  "credential",
  "publish",
] as const)(
  "human Workbench %s authorization persists, audits delegation, and revokes pending decisions",
  async (category) => {
    const f = await m5Cross();
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const path = f.projectPath("/preferences");
      const write = (enabled: boolean) =>
        f.call(path, {
          method: "POST",
          body: { decision_delegation: { [category]: enabled } },
          headers: { "idempotency-key": `${category}-${enabled}` },
        });
      expect((await f.call(path)).json).toMatchObject({
        decision_delegation: { [category]: false, permission: true },
      });
      for (const owner of [
        f.primary.owner,
        ...f.state().assignments.filter((a) => a.scope === "standing"),
      ]) {
        expect(
          (
            await f.call(path, {
              method: "POST",
              anonymous: true,
              body: { decision_delegation: { [category]: true } },
              headers: {
                authorization: `Bearer ${f.token(owner)}`,
                "idempotency-key": `agent-${owner.id}`,
              },
            })
          ).status,
        ).toBe(401);
      }
      const first = await write(true);
      expect(first.status).toBe(200);
      expect((await write(true)).json).toEqual(first.json);
      expect((await f.call(path)).json).toMatchObject({
        decision_delegation: { [category]: true, permission: true },
      });
      const audit = f
        .state()
        .events.findLast((e) => e.type === "project_preferences_updated");
      expect(audit?.actor).toMatchObject({
        kind: "human",
        project_id: f.project.project_id,
      });
      const make = () =>
        f.command((s, a, p) =>
          requestDecision(
            s,
            a,
            {
              card_id: f.card.id,
              category,
              kind: "choose",
              question: "处理合成事项？",
              context: "仅测试数据",
              options: [
                { key: "go", description: "继续", impact: "记录合成决定" },
              ],
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
      const q = make();
      expect(q.decider).toBe("role:pm");
      expect(q.delegation_authority).toContain(`/event:${audit?.id}`);
      const ops = f
        .state()
        .assignments.find(
          (a) => a.scope === "standing" && a.standing_mode === "ops",
        );
      if (!ops) throw new Error("Missing Ops");
      await f.start(ops);
      await f.mcp(ops, "resolve_delegated_decision", {
        decision_id: q.id,
        option: "go",
        rationale: "依人类授权",
      });
      const needs = (await f.call(f.projectPath("/needs-you"))).json;
      expect(JSON.stringify(needs)).toContain("PM 依常驻授权代拍");
      expect(JSON.stringify(needs)).toContain(`/event:${audit?.id}`);
      const pending = make();
      expect((await write(false)).status).toBe(200);
      expect(
        f.state().decisions.find((d) => d.id === pending.id)?.decider,
      ).toBe("human");
      expect(make().decider).toBe("human");
      expect(
        f.state().decisions.find((d) => d.id === q.id)?.resolution,
      ).toMatchObject({
        via: "delegated",
        proxy_authority: q.delegation_authority,
      });
    } finally {
      await f.close();
    }
  },
);

test("C-304: explicit reason survives storage and reaches authenticated Needs You, card details and CLI", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const reason = "数值和行为规则须由人决定";
    const q = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          category: "credential",
          kind: "choose",
          question: "是否调整处理规则",
          context: "已核对影响",
          options: [{ key: "go", description: "调整", impact: "改变行为" }],
          recommended: "go",
          decider: "human",
          human_required_reason: reason,
          plain_summary: TEST_PLAIN_SUMMARY,
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
        },
        p,
      ),
    );
    expect(q.decider).toBe("human");
    for (const path of ["/needs-you", `/cards/${f.card.id}`]) {
      expect((await f.call(f.projectPath(path))).json).toMatchObject({
        decisions: expect.arrayContaining([
          expect.objectContaining({
            id: q.id,
            human_required_reason: reason,
            decider: "human",
          }),
        ]),
      });
      const anonymous = await f.call(f.projectPath(path), { anonymous: true });
      expect(anonymous.status).toBe(401);
      expect(JSON.stringify(anonymous.json)).not.toContain(reason);
    }
    expect(await f.cli("needs-you")).toContain(`须由你亲自决定：${reason}`);
    const response = await f.call(f.projectPath(`/decisions/${q.id}/resolve`), {
      method: "POST",
      body: { option: "go" },
    });
    expect(response.status).toBe(200);
    expect(f.state().decisions.find((d) => d.id === q.id)).toMatchObject({
      status: "resolved",
      human_required_reason: reason,
      resolution: { resolved_by: "human" },
    });
  } finally {
    await f.close();
  }
});

test("Workbench answers and grants atomically, enforces fixed risks and filters human/PM history", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    expect(
      (
        await f.call(f.projectPath("/preferences"), {
          method: "POST",
          headers: { "idempotency-key": "scope-off-first" },
          body: { decision_delegation: { scope_change: false } },
        })
      ).status,
    ).toBe(200);
    const make = (category: "scope_change" | "general" | "credential") =>
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
    const risk = make("credential");
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
          body: { decision_delegation: { credential: true } },
        })
      ).status,
    ).toBe(200);
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
    expect(grants).toHaveLength(3);
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

async function humanAuthorizationAcross(
  phase:
    | "idle"
    | "publication lock"
    | "Git preparation"
    | "ungated Git preparation"
    | "published",
) {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const set = (body: object, key: string, token?: string) =>
      f.call(
        f.projectPath(
          (key === "human-off" ||
            key === "human-on" ||
            key.startsWith("off-")) &&
            phase !== "published"
            ? `/cards/${f.card.id}/sensitive`
            : "/preferences",
        ),
        {
          method: "POST",
          anonymous: !!token,
          headers: {
            "idempotency-key": key,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body:
            (key === "human-off" || key.startsWith("off-")) &&
            phase !== "published"
              ? { sensitive: true }
              : key === "human-on"
                ? { sensitive: false }
                : body,
        },
      );
    expect((await f.call(f.projectPath("/preferences"))).json).toMatchObject({
      pm_confirm_human_decided_merges: true,
    });
    expect((await set({ pm_merge_confirmation: true }, "pm-on")).status).toBe(
      200,
    );
    expect(
      (await set({ pm_confirm_human_decided_merges: "yes" }, "invalid")).status,
    ).toBe(400);
    const source = f.command((s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          category: "permission",
          kind: "choose",
          question: "批准权限改动？",
          context: "测试方案",
          options: [{ key: "yes", description: "批准", impact: "按方案实施" }],
          recommended: "yes",
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
          affected_cards: [f.card.id],
          affected_work_items: [],
          blocking: false,
        },
        p,
      ),
    );
    expect(
      (
        await f.call(f.projectPath(`/decisions/${source.id}/resolve`), {
          method: "POST",
          headers: { "idempotency-key": "human-answer" },
          body: { option: "yes", rationale: "正式批准", raw_quote: "同意" },
        })
      ).status,
    ).toBe(200);
    const ops = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing PM Ops");
    await f.start(ops);
    await f.start(f.primary.owner);
    for (const owner of [ops, f.primary.owner]) {
      const token = f.token(owner);
      if (!token) throw new Error("Missing issued token");
      expect(
        await main(
          [
            "preference",
            "set",
            "pm-confirm-human-decided-merges",
            "off",
            "--project",
            f.project.project_id,
          ],
          {
            ...createProcessIo(),
            cwd: f.root,
            env: { CARDIGAN_DATA_DIR: f.dataDir, CARDIGAN_TOKEN: token },
            stdout: () => {},
            stderr: () => {},
          },
        ),
      ).not.toBe(0);
      expect(
        (
          await set(
            { pm_confirm_human_decided_merges: false },
            `denied-${owner.id}`,
            token,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await f.raw(owner, "set_project_preferences", {
            pm_confirm_human_decided_merges: false,
          })
        ).isError,
      ).toBe(true);
    }
    const product = await f.deliver(
      f.primary,
      await f.change(f.primary.owner, "approved.txt", "approved behavior\n"),
    );
    await f.review(f.primary.verifier, product);
    const completion = await f.complete(product);
    const confirmation = f
      .state()
      .decisions.find((q) => q.trigger === "merge_confirmation");
    if (!confirmation) throw new Error("Missing confirmation");
    expect(confirmation.decider).toBe("role:pm");
    const preparedPlan = prepareMergePlan(
      { ...f.state(), project_settings: { merge_gate_enabled: true } },
      f.card.id,
    );
    if (!preparedPlan.ok) throw new Error(preparedPlan.error.message);
    const project = f.binding().projectOf(f.project.project_id);
    if (!project) throw new Error("Missing project");
    const candidate = await f.binding().prepare(project, preparedPlan.value);
    if (candidate.status !== "candidate") throw new Error("Missing candidate");
    const check = {
      card_id: f.card.id,
      completion_id: completion.id as DeliveryId,
      attempt_id: "human-merge",
      candidate_sha: candidate.candidate_sha,
      tree_sha: candidate.tree_sha,
      base_sha: candidate.previous_sha,
    };
    for (const status of ["queued", "running", "passed"] as const)
      f.command((s, _a, p) =>
        recordMergeCheck(
          { ...s, project_settings: { merge_gate_enabled: true } },
          { kind: "system", project_id: s.project_id },
          status === "passed"
            ? {
                ...check,
                status,
                checks: [
                  {
                    name: "unit",
                    status: "passed",
                    exit_code: 0,
                    duration_ms: 1,
                  },
                ],
                summary: "passed",
                log_ref: "human-merge.log",
              }
            : { ...check, status },
          p,
        ),
      );
    expect((await f.call(f.projectPath("/needs-you"))).json).toMatchObject({
      pm_held_merges: [
        expect.objectContaining({
          id: confirmation.id,
          merge_confirmation: expect.objectContaining({
            decision_evidence_required: [],
          }),
        }),
      ],
    });
    const answer = {
      decision_id: confirmation.id,
      option: "merge",
      rationale: "核对一致",
      notice: "已核对授权与交付",
    };
    expect(
      (
        await f.raw(ops, "resolve_delegated_decision", {
          ...answer,
          notice: "",
        })
      ).isError,
    ).toBe(true);
    const evidence = [
      {
        decision_id: source.id,
        option: "yes",
        completion_id: completion.id,
        delivery_id: product.id,
        target_sha: product.subject.value,
        evidence: "approved.txt 实现批准的行为",
      },
    ];
    expect(
      (
        await f.raw(ops, "resolve_delegated_decision", {
          ...answer,
          decision_evidence: [{ ...evidence[0], target_sha: "f".repeat(40) }],
        })
      ).isError,
    ).toBe(true);
    const approved = await f.mcp<Decision>(ops, "resolve_delegated_decision", {
      ...answer,
      decision_evidence: evidence,
    });
    expect(
      approved.resolution?.human_decided_merge_basis?.entries[0],
    ).toMatchObject(evidence[0] as object);
    expect(mergePlan(f.state(), f.card.id).ok).toBe(true);
    if (phase !== "idle") {
      const blocked = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const errors: unknown[] = [];
      const gate = new MergeChecks({
        store: f.store(),
        git: f.binding(),
        clock: { now: () => new Date(f.now()).toISOString() },
        execution: { mode: "local", dataDir: f.dataDir },
        configuration: {
          errors: [],
          forProject: () => ({
            status: "enabled",
            checks: [{ name: "unit", run: "true" }],
            totalTimeoutMs: 1000,
            env: {},
          }),
        },
        sweep: async () => {},
        run: async () => {
          throw new Error("Exact tree already passed");
        },
        onError: (error) => errors.push(error),
      });
      const baseline = await f.binding().baseline(project);
      let held: Promise<void> | undefined;
      let publication: Promise<void> | undefined;
      let restore = () => {};
      let disposed: Promise<void> | undefined;
      const dispose = () =>
        (disposed ??= (async () => {
          resume.resolve();
          restore();
          gate.stop();
          await Promise.allSettled([held, publication]);
          await gate.idle();
        })());
      // Timeouts must also release the lock and restore the shared Git prototype.
      onTestFinished(dispose);
      if (phase === "publication lock") {
        const entered = Promise.withResolvers<void>();
        held = withPublication(project.project_id, () => {
          entered.resolve();
          return resume.promise;
        });
        await entered.promise;
        // Observe the real release reaching its await on the occupied lock.
        const target = gate as unknown as {
          release(...args: unknown[]): Promise<void>;
        };
        const release = target.release.bind(gate);
        const spy = vi
          .spyOn(target, "release")
          .mockImplementation((...args) => {
            const work = release(...args);
            blocked.resolve();
            return work;
          });
        restore = () => spy.mockRestore();
      } else if (
        phase === "Git preparation" ||
        phase === "ungated Git preparation"
      ) {
        const swap = CentralGitTransport.prototype.compareAndSwapRef;
        const spy = vi
          .spyOn(CentralGitTransport.prototype, "compareAndSwapRef")
          .mockImplementation(async function (...args) {
            if (args[4]) {
              blocked.resolve();
              await resume.promise;
            }
            return swap.apply(this, args);
          });
        restore = () => spy.mockRestore();
      }
      try {
        publication =
          phase === "ungated Git preparation"
            ? new MergeExecutor({ store: f.store(), git: f.binding() }).tick()
            : gate.tick([f.project.project_id]);
        if (phase === "published") {
          await publication;
          expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
            "done",
          );
          expect(await f.binding().baseline(project)).not.toBe(baseline);
        } else {
          await Promise.race([
            blocked.promise,
            publication.then(() => {
              throw new Error(`Publication completed before ${phase}`, {
                cause: errors[0],
              });
            }),
          ]);
        }
        expect(
          (
            await set(
              { pm_confirm_human_decided_merges: false },
              `off-${phase}`,
            )
          ).status,
        ).toBe(200);
        if (phase !== "published") {
          expect(
            f.state().decisions.find((q) => q.id === confirmation.id)?.status,
          ).toBe("superseded");
          expect(mergePlan(f.state(), f.card.id).ok).toBe(false);
          resume.resolve();
          await publication;
          expect(await f.binding().baseline(project)).toBe(baseline);
          expect(f.state().events.some((e) => e.type === "card_merged")).toBe(
            false,
          );
          expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
            "awaiting_merge",
          );
        }
        expect(errors).toEqual([]);
      } finally {
        await dispose();
      }
      return;
    }
    expect(
      (await set({ pm_confirm_human_decided_merges: false }, "human-off"))
        .status,
    ).toBe(200);
    expect(
      f.state().decisions.find((q) => q.id === confirmation.id)?.status,
    ).toBe("superseded");
    const publish = vi.spyOn(f.binding(), "merge");
    await new MergeExecutor({ store: f.store(), git: f.binding() }).tick();
    expect(publish).not.toHaveBeenCalled();
    expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
      "awaiting_merge",
    );
    expect(mergePlan(f.state(), f.card.id).ok).toBe(false);
    expect((await f.call(f.projectPath("/needs-you"))).json).toMatchObject({
      decisions: [
        expect.objectContaining({
          decider: "human",
          trigger: "merge_confirmation",
        }),
      ],
    });
    expect(
      (await set({ pm_confirm_human_decided_merges: true }, "human-on")).status,
    ).toBe(200);
    expect(mergePlan(f.state(), f.card.id).ok).toBe(false);
  } finally {
    await f.close();
  }
}

test.each([
  "idle",
  "publication lock",
  "Git preparation",
  "ungated Git preparation",
  "published",
] as const)(
  "C-309: current human authorization across %s",
  humanAuthorizationAcross,
  30_000,
);
