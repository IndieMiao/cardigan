import type { Actor, Assignment, Decision } from "../../index.js";
import {
  confirmSourceMergeUnrelated,
  resolveDelegatedDecision,
} from "../../index.js";
import { systemMergeFixture } from "../system-merge/test-fixtures.js";
import { assignment, human, id, role } from "../test-fixtures.js";

export const SOURCE_SECRET = "C311_SYNTHETIC_SENSITIVE_CONTEXT";

/** Audited legacy flow-4 project with an unrelated, sensitive source card. */
export async function sourceMergeSystemFixture(): Promise<
  Awaited<ReturnType<typeof systemMergeFixture>> & {
    source: Decision;
    ops: Assignment;
    actor: Actor;
    propose: () => ReturnType<typeof resolveDelegatedDecision>;
    confirm: () => ReturnType<typeof confirmSourceMergeUnrelated>;
  }
> {
  const source: Decision = {
    id: id("decision", 901),
    key: id("decision", 901),
    card_id: id("card", 902),
    raised_by: "human",
    category: "credential",
    kind: "choose",
    question: `question:${SOURCE_SECRET}`,
    context: `context:${SOURCE_SECRET}`,
    options: [
      { key: "yes", description: `option:${SOURCE_SECRET}`, impact: "account" },
    ],
    recommended: "yes",
    affected_cards: [],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    doc_refs: [],
    status: "resolved",
    resolution: {
      option: "yes",
      rationale: `reason:${SOURCE_SECRET}`,
      raw_quote: `quote:${SOURCE_SECRET}`,
      resolved_by: "human",
      via: "needs_you",
      via_chain: ["human"],
      at: "2026-01-01T00:00:00Z",
    },
  };
  const fixture = await systemMergeFixture({
    beforeReview: (s) => {
      const card = s.cards[0];
      if (!card) throw new Error("Missing fixture card");
      return {
        ...s,
        decisions: [...s.decisions, source],
        cards: [
          ...s.cards.map((c) => ({
            ...c,
            source: { kind: "decision" as const, decision_id: source.id },
          })),
          {
            ...card,
            id: id("card", 902),
            sensitive: true,
            title: "Sensitive synthetic source",
            status: "todo" as const,
          },
        ],
      };
    },
  });
  const { f, q, check } = fixture;
  check();
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  const actor: Actor = {
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: ops.id,
    ...role("pm"),
  };
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [{ collection: "assignments", entity: ops }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  const propose = () =>
    resolveDelegatedDecision(
      f.state,
      actor,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "Checked",
        escalate: true,
        source_unrelated: {
          decision_id: source.id,
          rationale: "Label only; no account use",
        },
      },
      f.io,
    );
  const confirm = () =>
    confirmSourceMergeUnrelated(
      f.state,
      human,
      {
        decision_id: q.id,
        card_id: f.card.id,
        source_decision_id: source.id,
        version: 1,
      },
      { ...f.io, human_confirmation: "workbench" },
    );
  return { ...fixture, source, ops, actor, propose, confirm };
}
