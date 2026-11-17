import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type CommandState,
  type Decision,
  type MergeDecisionEvidence,
  mergePlan,
  recordDecision,
  recordMergeCheck,
  requestDecision,
  resolveDelegatedDecision,
  setProjectPreferences,
  standingTools,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { assignment, human, machine, ports, role } from "./test-fixtures.js";

const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const pm: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};
const summary = {
  changed: "按已批准方案修改",
  impact: "保持批准的行为",
  risk: "无",
};

async function setup(
  category: "scope_change" | "permission" = "scope_change",
  enabled?: boolean,
) {
  const state: CommandState = {
    project_settings: { merge_gate_enabled: true },
    project_id: human.project_id,
    machines: [machine()],
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [ops],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  const f = mergeFixture("confirm", 3, { state, ports: ports() });
  if (enabled !== undefined)
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { pm_confirm_human_decided_merges: enabled },
        f.io,
      ),
    );
  const source = f.commit(
    requestDecision(
      f.state,
      human,
      {
        card_id: f.card.id,
        category,
        kind: "choose",
        question: "批准此改动？",
        context: "需求",
        options: [{ key: "yes", description: "批准", impact: "按此实施" }],
        recommended: "yes",
        affected_cards: [f.card.id],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: summary,
      },
      f.io,
    ),
  );
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: source.id,
        option: "yes",
        rationale: "批准",
        raw_quote: "同意",
      },
      { ...f.io, human_confirmation: "workbench" },
    ),
  );
  const { product, completion } = await f.accept();
  const confirmation = () =>
    f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1) as Decision;
  const system: Actor = { kind: "system", project_id: human.project_id };
  const check = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "check",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  for (const status of ["queued", "running"] as const)
    f.commit(recordMergeCheck(f.state, system, { ...check, status }, f.io));
  f.commit(
    recordMergeCheck(
      f.state,
      system,
      {
        ...check,
        status: "passed",
        summary: "passed",
        log_ref: "check.log",
        checks: [
          { name: "unit", status: "passed", exit_code: 0, duration_ms: 1 },
        ],
      },
      f.io,
    ),
  );
  const evidence: MergeDecisionEvidence[] = [
    {
      decision_id: source.id,
      option: "yes",
      completion_id: completion.id,
      delivery_id: product.id,
      target_sha: product.subject.value,
      evidence: "src/feature.ts 按所选方案实现权限校验",
    },
  ];
  const answer = (
    entries: readonly MergeDecisionEvidence[] | null | undefined = evidence,
    snapshot = f.state,
  ) =>
    resolveDelegatedDecision(
      snapshot,
      pm,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "逐项核对一致",
        notice: "已核对人的批准与交付",
        ...(entries ? { decision_evidence: entries } : {}),
      },
      f.io,
    );
  return { f, source, product, completion, confirmation, evidence, answer };
}

test.each(["scope_change", "permission"] as const)(
  "Flow Lite: %s merges use current gates without per-delivery decision mappings",
  async (category) => {
    for (const enabled of [undefined, true, false]) {
      const { f, confirmation, answer } = await setup(category, enabled);
      expect(confirmation().decider).toBe("role:pm");
      f.commit(answer(null));
      expect(mergePlan(f.state, f.card.id).ok).toBe(true);
      expect(confirmation().resolution?.notice).toBeTruthy();
      expect(confirmation()).not.toHaveProperty("human_decided_merge_basis");
    }
  },
);

test.each(["scope_change", "permission"] as const)(
  "Flow Lite: %s never overrides a withdrawn required pass or active human blocker",
  async (category) => {
    const { f, answer } = await setup(category);
    const state = { ...f.state, reviews: [] };
    expect(answer(null, state).ok).toBe(false);
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  },
);
