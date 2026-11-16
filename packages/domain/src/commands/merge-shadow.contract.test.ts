import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type CommandState,
  currentPreMergeVersions,
  type Decision,
  displayChangedPath,
  evaluateMergeShadow,
  expireMergeSnoozes,
  type MergeClassificationInput,
  type MergeShadowPaths,
  mergeClassificationView,
  mergeShadowComparisons,
  postComment,
  recordDecision,
  recordMergeCheck,
  recordMergeShadow,
  resolveDelegatedDecision,
  setProjectPreferences,
  updateCard,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, assignment, human, id, role, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
};
const policy = {
  role_rule_paths: ["packages/roles/**", "AGENTS.md"],
  release_paths: ["release/**"],
};
async function fixture() {
  const f = mergeFixture();
  // Seed a standing PM, then exercise the actual completion/check/classification commands.
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
  const { product, completion } = await f.accept();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { system_merge_shadow: true, system_merge_shadow_policy: policy },
      f.io,
    ),
  );
  const q = f.state.decisions.find((q) => q.trigger === "merge_confirmation");
  if (!q) throw new Error("missing confirmation");
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "test",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  for (const status of ["queued", "running", "passed"] as const)
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        {
          ...identity,
          status,
          summary: "pass",
          log_ref: "test.log",
          checks: [
            {
              name: "test",
              status: "passed" as const,
              exit_code: 0,
              duration_ms: 1,
            },
          ],
        },
        f.io,
      ),
    );
  const input = (): MergeClassificationInput => ({
    checked_versions: currentPreMergeVersions(
      f.card,
      f.state.work_items,
      f.state.deliveries,
    ),
    read_through_seq: Math.max(
      0,
      ...f.state.events
        .filter((e) => e.card_id === f.card.id)
        .map((e) => e.seq),
    ),
    risk_tags: [],
    risk_reviewed: true,
    is_ui: false,
    numeric_rules_approved: true,
    numeric_decision_ids: [],
    not_external_release: true,
    no_role_changes: true,
    timeline_reviewed: true,
  });
  f.commit(
    updateCard(
      f.state,
      human,
      { card_id: f.card.id, merge_classification: input() },
      f.io,
    ),
  );
  const paths: MergeShadowPaths = {
    completion_id: completion.id,
    base_branch: "main",
    base_sha: "f".repeat(40),
    versions: input().checked_versions.map((v) => ({
      ...v,
      paths: ["src/main.ts"],
    })),
  };
  return { ...f, state: f.state, input, q, product, completion, paths };
}
const cards = (
  s: CommandState,
  patch: Partial<CommandState["cards"][number]>,
): CommandState => ({ ...s, cards: s.cards.map((c) => ({ ...c, ...patch })) });
const decision = (s: CommandState, q: Decision): CommandState => ({
  ...s,
  decisions: s.decisions.map((d) => (d.id === q.id ? q : d)),
});

test("D6: merge shadow uses the same final filename prefix matching", async () => {
  const f = await fixture();
  const state = {
    ...f.state,
    project_preferences: [
      {
        id: human.project_id,
        auto_merge_after_minutes: null,
        system_merge_shadow_policy: {
          ...policy,
          release_paths: ["packages/host/src/deployment*"],
        },
      },
    ],
  };
  for (const [path, expected] of [
    ["packages/host/src/deployment-node.ts", "failed"],
    ["packages/host/src/deployment/nested.ts", "passed"],
  ]) {
    const paths = {
      ...f.paths,
      versions: f.paths.versions.map((v) => ({
        ...v,
        paths: [path as string],
      })),
    };
    expect(evaluateMergeShadow(state, f.q, paths).conditions[5]?.status).toBe(
      expected,
    );
  }
});

test("D6: merge shadow treats glob characters and spaces in Git names literally", async () => {
  const f = await fixture();
  const paths = {
    ...f.paths,
    versions: f.paths.versions.map((v) => ({
      ...v,
      paths: ["docs/a b.md", "web/app/[id]/page.tsx", "notes/what?.md"],
    })),
  };
  expect(
    evaluateMergeShadow(f.state, f.q, paths)
      .conditions.slice(4, 6)
      .map((c) => c.status),
  ).toEqual(["passed", "passed"]);
});

test.each(["\t", "\n", "\u001b", "\u0085"])(
  "D6: shadow classifies control character %j and escapes its reason",
  async (control) => {
    const f = await fixture();
    const path = `release/file${control}.json`;
    const paths = {
      ...f.paths,
      versions: f.paths.versions.map((v) => ({ ...v, paths: [path] })),
    };
    const condition = evaluateMergeShadow(f.state, f.q, paths).conditions[5];
    expect(condition?.status).toBe("failed");
    expect(condition?.reason).toContain(displayChangedPath(path));
    expect(condition?.reason).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
  },
);

test("C-238: all 16 conditions can pass, but the only effect is a system audit; replay is durable and idempotent", async () => {
  const f = await fixture();
  const result = value(
    recordMergeShadow(
      f.state,
      system,
      { decision_id: f.q.id, paths: f.paths },
      f.io,
    ),
  );
  expect(result.data).toMatchObject({ would_confirm: true });
  expect(result.data?.conditions).toHaveLength(16);
  expect(result.changes).toEqual([]);
  expect(result.events.map((e) => e.type)).toEqual([
    "system_merge_shadow_recorded",
  ]);
  expect(result.timeline[0]?.author).toBe("system");
  const restored = JSON.parse(
    JSON.stringify(apply(f.state, result)),
  ) as CommandState;
  const repeated = value(
    recordMergeShadow(
      restored,
      system,
      { decision_id: f.q.id, paths: f.paths },
      f.io,
    ),
  );
  expect(repeated.events).toEqual([]);
  expect(restored.decisions).toEqual(f.state.decisions);
  expect(restored.cards).toEqual(f.state.cards);
  expect(restored.runs).toEqual(f.state.runs);
  expect(mergeShadowComparisons(restored, f.card.id)[0]).toMatchObject({
    prediction: { would_confirm: true },
    actual: { status: "open", decider: "role:pm", resolution: null },
  });
});

test.each(Array.from({ length: 16 }, (_, i) => i + 1))(
  "C-238 condition %s rejects independently",
  async (number) => {
    const f = await fixture();
    let s = f.state,
      q = f.q,
      paths = f.paths;
    switch (number) {
      case 1:
        s = cards(s, { sensitive: true });
        break;
      case 2:
      case 3:
        s = {
          ...s,
          decisions: [
            ...s.decisions,
            {
              ...q,
              id: id("decision", 999),
              trigger: "completion_review",
              category: number === 2 ? "permission" : "scope_change",
              status: "resolved",
            } as Decision,
          ],
        };
        break;
      case 4:
        q = { ...q, decider: "human" };
        s = decision(s, q);
        break;
      case 5:
      case 6:
        paths = {
          ...paths,
          versions: paths.versions.map((v) => ({
            ...v,
            paths: [number === 5 ? "packages/roles/new.ts" : "release/new.ts"],
          })),
        };
        break;
      case 7:
        s = {
          ...s,
          events: s.events.filter((e) => e.type !== "merge_check_finished"),
        };
        break;
      case 8:
        s = {
          ...s,
          work_items: s.work_items.map((w) =>
            w.kind === "verify" ? { ...w, status: "todo" } : w,
          ),
        };
        break;
      case 9:
        s = {
          ...s,
          reviews: s.reviews.map((r) => ({
            ...r,
            issues: [
              {
                severity: "major",
                description: "fix",
                must_fix: true,
                pre_existing: false,
              },
            ],
          })),
        };
        break;
      case 10:
        s = cards(s, {
          pre_merge_checks: [
            {
              label: "audit",
              status: "pending",
              updated_at: f.card.created_at,
              updated_by: "human",
            },
          ],
        });
        break;
      case 11:
        s = cards(s, { risk_tags: ["numeric_rule"] });
        break;
      case 12:
        s = cards(s, {
          merge_classification: {
            ...required(required(s.cards[0]).merge_classification),
            is_ui: true,
          },
        });
        break;
      case 13:
        s = {
          ...s,
          work_items: s.work_items.map((w) =>
            w.kind === "produce"
              ? {
                  ...w,
                  reported_blocker: {
                    reason: "wait",
                    needs: "human",
                    reported_at: f.card.created_at,
                    reported_by: "human",
                  },
                }
              : w,
          ),
        } as CommandState;
        break;
      case 14:
        s = apply(
          s,
          value(
            postComment(
              s,
              human,
              { card_id: f.card.id, body: "new comment" },
              f.io,
            ),
          ),
        );
        break;
      case 15:
        s = cards(s, { merge_policy: "auto" });
        break;
      case 16:
        s = cards(s, {
          merge_classification: {
            ...required(required(s.cards[0]).merge_classification),
            risk_reviewed: false,
          },
        });
        break;
    }
    const result = evaluateMergeShadow(s, q, paths);
    expect(result.would_confirm).toBe(false);
    expect(result.conditions.find((c) => c.number === number)?.status).not.toBe(
      "passed",
    );
    const effect = value(
      recordMergeShadow(s, system, { decision_id: q.id, paths }, f.io),
    );
    expect(effect.changes).toEqual([]);
    expect(
      effect.events.every((e) => e.type === "system_merge_shadow_recorded"),
    ).toBe(true);
  },
);

test("C-238: only standing PM/Office or human can classify; system and all work-item identities cannot", async () => {
  const f = await fixture();
  for (const actor of [
    system,
    f.actor(f.coder),
    f.actor(f.reviewer),
    f.actor(f.pm),
  ])
    expect(
      updateCard(
        f.state,
        actor,
        { card_id: f.card.id, merge_classification: f.input() },
        f.io,
      ).ok,
    ).toBe(false);
  expect(
    updateCard(
      f.state,
      opsActor,
      { card_id: f.card.id, merge_classification: f.input() },
      f.io,
    ).ok,
  ).toBe(true);
  const officeState = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === ops.id ? { ...ops, standing_mode: "office" as const } : a,
    ),
  };
  expect(
    updateCard(
      officeState,
      opsActor,
      { card_id: f.card.id, merge_classification: f.input() },
      f.io,
    ).ok,
  ).toBe(true);
  for (const actor of [human, opsActor, f.actor(f.coder)]) {
    expect(
      recordMergeShadow(
        f.state,
        actor,
        { decision_id: f.q.id, paths: f.paths },
        f.io,
      ).ok,
    ).toBe(false);
    if (actor.kind !== "human")
      expect(
        setProjectPreferences(
          f.state,
          actor,
          { system_merge_shadow: true },
          f.io,
        ).ok,
      ).toBe(false);
  }
});

test("C-238: classification binds exact IDs and SHA; malformed, missing, stale, mixed and unread inputs fail atomically", async () => {
  const f = await fixture();
  const input = f.input();
  const late = apply(
    f.state,
    value(
      postComment(f.state, human, { card_id: f.card.id, body: "wait" }, f.io),
    ),
  );
  for (const patch of [
    null,
    { ...input, risk_reviewed: undefined },
    { ...input, is_ui: undefined },
    { ...input, risk_tags: ["permission"] },
    { ...input, numeric_decision_ids: [id("decision", 999)] },
    {
      ...input,
      checked_versions: input.checked_versions.map((v) => ({
        ...v,
        subject: "b".repeat(40),
      })),
    },
    { ...input, checked_versions: [] },
  ])
    expect(
      updateCard(
        f.state,
        human,
        {
          card_id: f.card.id,
          merge_classification: patch as MergeClassificationInput,
        },
        f.io,
      ).ok,
    ).toBe(false);
  expect(
    updateCard(
      late,
      human,
      { card_id: f.card.id, merge_classification: input },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    updateCard(
      f.state,
      human,
      { card_id: f.card.id, merge_classification: input, title: "mixed" },
      f.io,
    ).ok,
  ).toBe(false);
  const newer = {
    ...f.state,
    deliveries: f.state.deliveries.map((v) =>
      v.id === f.product.id ? { ...v, id: id("delivery", 999) } : v,
    ),
  };
  expect(mergeClassificationView(newer, required(newer.cards[0]))?.stale).toBe(
    true,
  );
  expect(evaluateMergeShadow(newer, f.q, f.paths).would_confirm).toBe(false);
});

test.each(["human", "agent"])(
  "C-238: same-timestamp %s comments are ordered by seq; reread can restore classification",
  async (author) => {
    const f = await fixture();
    const actor = author === "human" ? human : f.actor(f.coder);
    const after = apply(
      f.state,
      value(
        postComment(
          f.state,
          actor,
          { card_id: f.card.id, body: "new", refs: [], mentions: [] },
          f.io,
        ),
      ),
    );
    expect(
      evaluateMergeShadow(after, f.q, f.paths).conditions[13]?.status,
    ).toBe("failed");
    const maxSeq = Math.max(
      ...after.events.filter((e) => e.card_id === f.card.id).map((e) => e.seq),
    );
    const renewed = apply(
      after,
      value(
        updateCard(
          after,
          human,
          {
            card_id: f.card.id,
            merge_classification: { ...f.input(), read_through_seq: maxSeq },
          },
          f.io,
        ),
      ),
    );
    expect(evaluateMergeShadow(renewed, f.q, f.paths).would_confirm).toBe(true);
  },
);

test.each([
  undefined,
  null,
  { role_rule_paths: [], release_paths: [] },
  { role_rule_paths: ["../bad"], release_paths: ["release/**"] },
])(
  "C-238 missing/empty/invalid path config is uncertain",
  async (policyValue) => {
    const f = await fixture();
    const s = {
      ...f.state,
      project_preferences: [
        {
          id: human.project_id,
          auto_merge_after_minutes: null,
          system_merge_shadow: true,
          ...(policyValue === undefined
            ? {}
            : { system_merge_shadow_policy: policyValue }),
        },
      ],
    };
    const result = evaluateMergeShadow(s, f.q, f.paths);
    expect(result.conditions.slice(4, 6).map((c) => c.status)).toContain(
      "uncertain",
    );
    expect(result.would_confirm).toBe(false);
  },
);

test("C-238: path evidence unavailable, wrong completion or invalid path cannot pass; switches default off", async () => {
  const f = await fixture();
  for (const paths of [
    undefined,
    { ...f.paths, completion_id: id("delivery", 999) },
    { ...f.paths, base_branch: "other" },
    {
      ...f.paths,
      versions: f.paths.versions.map((v) => ({ ...v, paths: ["../bad"] })),
    },
  ])
    expect(evaluateMergeShadow(f.state, f.q, paths).would_confirm).toBe(false);
  expect(
    value(
      recordMergeShadow(
        { ...f.state, project_preferences: [] },
        system,
        { decision_id: f.q.id },
        f.io,
      ),
    ).events,
  ).toEqual([]);
  expect(
    setProjectPreferences(
      f.state,
      human,
      {
        system_merge_shadow_policy: {
          role_rule_paths: ["**"],
          release_paths: [],
        },
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each([
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
] as const)(
  "C-238 source %s decisions remain human-bound, even when resolved",
  async (category) => {
    const f = await fixture();
    const source = {
      ...f.q,
      id: id("decision", 998),
      trigger: "completion_review" as const,
      category,
      status: "resolved" as const,
      affected_cards: [],
      card_id: id("card", 998),
    };
    const s = cards(
      { ...f.state, decisions: [...f.state.decisions, source] },
      { source: { kind: "decision", decision_id: source.id } },
    );
    expect(evaluateMergeShadow(s, f.q, f.paths).would_confirm).toBe(false);
  },
);

test("C-238 delegation preference/active Ops/human handoff and hold history cannot be bypassed", async () => {
  const f = await fixture();
  for (const s of [
    {
      ...f.state,
      assignments: f.state.assignments.filter((a) => a.id !== ops.id),
    },
    {
      ...f.state,
      project_preferences: f.state.project_preferences?.map((p) => ({
        ...p,
        pm_merge_confirmation: false,
      })),
    } as CommandState,
  ])
    expect(evaluateMergeShadow(s, f.q, f.paths).conditions[3]?.status).toBe(
      "failed",
    );
  for (const q of [
    { ...f.q, human_required_reason: "交人" },
    { ...f.q, status: "snoozed" as const },
    { ...f.q, status: "provisional" as const },
  ])
    expect(
      evaluateMergeShadow(decision(f.state, q), q, f.paths).would_confirm,
    ).toBe(false);
  const held = {
    ...f.state,
    events: [
      ...f.state.events,
      {
        ...required(f.state.events.at(-1)),
        type: "decision_provisionally_resolved",
        payload: { decision_id: f.q.id, option: "hold" },
      },
    ],
  };
  expect(evaluateMergeShadow(held, f.q, f.paths).conditions[14]?.status).toBe(
    "failed",
  );
});

test("C-238 risk cards need current real independent review; a label alone cannot authorize", async () => {
  const f = await fixture();
  for (const risk of ["security", "permission"] as const) {
    const s = cards(f.state, {
      risk_tags: [risk],
      merge_classification: {
        ...required(required(f.state.cards[0]).merge_classification),
        risk_tags: [risk],
      },
    });
    expect(evaluateMergeShadow(s, f.q, f.paths).conditions[10]?.status).toBe(
      "failed",
    );
  }
});

test("C-238 audit comparisons retain the prediction and show the actual PM decision/handoff", async () => {
  const f = await fixture();
  const s = apply(
    f.state,
    value(
      recordMergeShadow(
        f.state,
        system,
        { decision_id: f.q.id, paths: f.paths },
        f.io,
      ),
    ),
  );
  const resolved: Decision = {
    ...f.q,
    status: "resolved",
    resolution: {
      option: "merge",
      rationale: "pass",
      raw_quote: "merge",
      resolved_by: `assignment:${ops.id}`,
      via: "delegated",
      via_chain: [`assignment:${ops.id}`],
      at: f.io.clock.now(),
    },
  };
  const compared = mergeShadowComparisons(decision(s, resolved), f.card.id)[0];
  expect(compared).toMatchObject({
    prediction: { would_confirm: true },
    actual: {
      status: "resolved",
      resolution: { option: "merge", resolved_by: `assignment:${ops.id}` },
    },
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture value");
  return value;
}

test.each(["pm", "human"] as const)(
  "C-238: real %s hold remains ineligible after expiry, restart and reclassification",
  async (who) => {
    const f = await fixture();
    expect(evaluateMergeShadow(f.state, f.q, f.paths).would_confirm).toBe(true);
    const input = {
      decision_id: f.q.id,
      option: "hold",
      rationale: "Wait for review",
    };
    const held = value(
      who === "pm"
        ? resolveDelegatedDecision(f.state, opsActor, input, f.io)
        : recordDecision(
            f.state,
            human,
            { ...input, raw_quote: "Wait for review" },
            f.io,
          ),
    );
    expect(held.data.status).toBe("snoozed");
    expect(held.events.map((e) => e.type)).toContain(
      "merge_confirmation_snoozed",
    );
    const until = required(held.data.snooze?.until);
    const ports = { ...f.io, clock: { now: () => until } };
    const heldState = apply(f.state, held);
    const reopened = value(expireMergeSnoozes(heldState, system, ports));
    expect(reopened.events.map((e) => e.type)).toEqual(["decision_requested"]);
    const restored = JSON.parse(
      JSON.stringify(apply(heldState, reopened)),
    ) as CommandState;
    const q = required(restored.decisions.find((q) => q.id === f.q.id));
    expect(q.status).toBe("open");
    expect(q.snooze).toBeUndefined();
    expect(q.resolution).toBeUndefined();
    expect(
      evaluateMergeShadow(restored, q, f.paths).conditions[14]?.status,
    ).toBe("failed");
    const classified = apply(
      restored,
      value(
        updateCard(
          restored,
          human,
          {
            card_id: f.card.id,
            merge_classification: {
              ...f.input(),
              read_through_seq: Math.max(
                ...restored.events
                  .filter((e) => e.card_id === f.card.id)
                  .map((e) => e.seq),
              ),
            },
          },
          ports,
        ),
      ),
    );
    const result = evaluateMergeShadow(classified, q, f.paths);
    expect(
      result.conditions
        .filter((c) => c.status !== "passed")
        .map((c) => c.number),
    ).toEqual(who === "pm" ? [15] : [4, 15]);
    expect(result.would_confirm).toBe(false);
    const recorded = value(
      recordMergeShadow(
        classified,
        system,
        { decision_id: q.id, paths: f.paths },
        ports,
      ),
    );
    expect(recorded.data?.would_confirm).toBe(false);
    expect(recorded.changes).toEqual([]);
    expect(recorded.events.map((e) => e.type)).toEqual([
      "system_merge_shadow_recorded",
    ]);
    const after = JSON.parse(
      JSON.stringify(apply(classified, recorded)),
    ) as CommandState;
    expect(
      value(
        recordMergeShadow(
          after,
          system,
          { decision_id: q.id, paths: f.paths },
          ports,
        ),
      ).events,
    ).toEqual([]);
    expect(after.decisions).toEqual(classified.decisions);
  },
);

test("C-238: hold history follows the completion across confirmation IDs, but does not taint another completion", async () => {
  const f = await fixture();
  const held = value(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      {
        decision_id: f.q.id,
        option: "hold",
        rationale: "Wait for review",
      },
      f.io,
    ),
  );
  const historical = { ...held.data, status: "superseded" as const };
  const current = { ...f.q, id: id("decision", 999), key: id("decision", 999) };
  const state = { ...apply(f.state, held), decisions: [historical, current] };
  expect(
    evaluateMergeShadow(state, current, f.paths).conditions[14]?.status,
  ).toBe("failed");
  const differentCompletion = {
    ...state,
    decisions: [
      {
        ...historical,
        kind: "approve" as const,
        target: { delivery_id: id("delivery", 998) },
      },
      current,
    ],
  };
  expect(
    evaluateMergeShadow(differentCompletion, current, f.paths).would_confirm,
  ).toBe(true);
});

test.each(["pm", "human"] as const)(
  "C-238: comparison preserves a %s return after confirmation and failed checks",
  async (who) => {
    const f = await fixture();
    let s = apply(
      f.state,
      value(
        recordMergeShadow(
          f.state,
          system,
          { decision_id: f.q.id, paths: f.paths },
          f.io,
        ),
      ),
    );
    s = apply(
      s,
      value(
        resolveDelegatedDecision(
          s,
          opsActor,
          {
            decision_id: f.q.id,
            option: "merge",
            rationale: "Checks passed",
            notice: "Synthetic confirmation",
          },
          f.io,
        ),
      ),
    );
    const original = required(
      s.decisions.find((q) => q.id === f.q.id),
    ).resolution;
    const identity = {
      card_id: f.card.id,
      completion_id: f.completion.id,
      attempt_id: "returned-confirmation",
      candidate_sha: "b".repeat(40),
      tree_sha: "d".repeat(40),
    };
    for (const status of ["queued", "running", "failed"] as const) {
      const check =
        status === "failed"
          ? {
              ...identity,
              status,
              summary: "Synthetic failed check",
              log_ref: `${identity.attempt_id}.log`,
              checks: [
                {
                  name: "synthetic",
                  status: "failed" as const,
                  exit_code: 1,
                  duration_ms: 1,
                },
              ],
            }
          : { ...identity, status };
      s = apply(
        s,
        value(
          recordMergeCheck(
            { ...s, project_settings: { merge_gate_enabled: true } },
            system,
            check,
            f.io,
          ),
        ),
      );
    }
    const reason = "Fix the synthetic failing check";
    const params = {
      decision_id: f.q.id,
      option: "request_changes",
      rationale: reason,
    };
    const returned = value(
      who === "pm"
        ? resolveDelegatedDecision(
            s,
            opsActor,
            { ...params, notice: "Synthetic return" },
            f.io,
          )
        : recordDecision(s, human, { ...params, raw_quote: reason }, f.io),
    );
    const event = required(
      returned.events.find((e) => e.type === "merge_changes_requested"),
    );
    s = JSON.parse(JSON.stringify(apply(s, returned))) as CommandState;
    const before = JSON.stringify(s);
    const comparison = required(mergeShadowComparisons(s, f.card.id)[0]);
    expect(comparison.prediction).toMatchObject({ would_confirm: true });
    expect(comparison.actual).toMatchObject({
      status: "superseded",
      resolution: original,
    });
    expect(
      comparison.actual_events.filter((e) => e.type === "decision_resolved"),
    ).toHaveLength(1);
    expect(comparison.actual_events.at(-1)).toMatchObject({
      event_id: event.id,
      seq: event.seq,
      at: event.created_at,
      type: "merge_changes_requested",
      author: who === "pm" ? `assignment:${ops.id}` : "human",
      payload: { decision_id: f.q.id, completion_id: f.completion.id, reason },
    });
    expect(JSON.stringify(s)).toBe(before);
    expect(s.events.some((e) => e.type === "card_merged")).toBe(false);
    // Another confirmation's return is not part of this prediction's history.
    const unrelated = {
      ...event,
      payload: {
        ...(event.payload as Record<string, string>),
        decision_id: id("decision", 999),
      },
    };
    expect(
      mergeShadowComparisons(
        { ...s, events: [...s.events, unrelated] },
        f.card.id,
      ),
    ).toEqual([comparison]);
  },
);
