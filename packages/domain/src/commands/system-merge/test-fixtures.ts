import type {
  CommandState,
  Decision,
  DeliveryEvidence,
  Event,
} from "../../index.js";
import { parseEventId, recordMergeCheck } from "../../index.js";
import { mergeFixture } from "../merge/test-fixtures.js";
import { human, value } from "../test-fixtures.js";

export const system = { kind: "system" as const, project_id: human.project_id };
export const policy = {
  role_rule_paths: ["AGENTS.md"],
  release_paths: ["release/**"],
};
export function pathEvidence(
  paths = ["packages/domain/src/example.ts"],
  category = "ordinary",
): DeliveryEvidence[] {
  const binding = {
    sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  return [
    { kind: "commit", details: binding },
    {
      kind: "diff",
      details: {
        role_rule_inventory: {
          version: 1,
          ...binding,
          complete: true,
          changes: paths.map((path) => ({
            path,
            category,
            status: "M",
            edits: [],
          })),
        },
      },
    },
  ];
}

/** Synthetic future control-plane snapshot: the released version cap remains 2. */
export function futurePreferences(
  state: CommandState,
): Pick<CommandState, "events" | "project_preferences"> {
  const events: Event[] = [
    {
      id: value(parseEventId("00000000000000000000009001")),
      seq: 9001,
      actor: human,
      type: "project_preferences_updated",
      payload: { preference: "flow_version", old_value: 2, new_value: 4 },
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: value(parseEventId("00000000000000000000009002")),
      seq: 9002,
      actor: human,
      type: "project_preferences_updated",
      payload: {
        preference: "system_merge_shadow_policy",
        old_value: null,
        new_value: policy,
      },
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  return {
    events: [...state.events, ...events],
    project_preferences: [
      {
        id: state.project_id,
        auto_merge_after_minutes: null,
        flow_version: 4,
        system_merge_shadow_policy: policy,
      },
    ],
  };
}
export async function systemMergeFixture(
  options: {
    policy?: "auto" | "confirm";
    beforeReview?: (s: CommandState) => CommandState;
  } = {},
) {
  const f = mergeFixture(options.policy);
  const product = await f.deliver();
  f.review(product);
  const completion = await f.deliver("card_completion");
  const before = {
    ...f.state,
    ...futurePreferences(f.state),
    cards: f.state.cards.map((c) => ({ ...c, flow_version: 4 })),
    deliveries: f.state.deliveries.map((v) =>
      v.id === product.id ? { ...v, evidence: pathEvidence() } : v,
    ),
  };
  const seed = options.beforeReview?.(before) ?? before;
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [
        ...seed.cards.map((entity) => ({
          collection: "cards" as const,
          entity,
        })),
        ...seed.deliveries.map((entity) => ({
          collection: "deliveries" as const,
          entity,
        })),
        ...(seed.project_preferences ?? []).map((entity) => ({
          collection: "project_preferences" as const,
          entity,
        })),
        ...seed.decisions.map((entity) => ({
          collection: "decisions" as const,
          entity,
        })),
      ],
      events: seed.events.filter((e) => !f.state.events.includes(e)),
      timeline: [],
      token_requests: [],
    },
  });
  f.review(completion);
  const q = f.state.decisions.findLast(
    (q) => q.trigger === "merge_confirmation",
  ) as Decision;
  function check() {
    const identity = {
      card_id: f.card.id,
      completion_id: completion.id,
      attempt_id: "system-merge-check",
      candidate_sha: "d".repeat(40),
      tree_sha: "c".repeat(40),
    };
    for (const status of ["queued", "running"] as const)
      f.commit(
        recordMergeCheck(
          { ...f.state, project_settings: { merge_gate_enabled: true } },
          system,
          { ...identity, status },
          f.io,
        ),
      );
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        {
          ...identity,
          status: "passed",
          summary: "Passed",
          log_ref: "system-merge-check.log",
          checks: [
            { name: "test", status: "passed", exit_code: 0, duration_ms: 1 },
          ],
        },
        f.io,
      ),
    );
  }
  return { f, product, completion, q, check };
}
