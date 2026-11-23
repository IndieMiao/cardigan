import { expect, test } from "vitest";
import {
  autoMergeOn,
  autoRiskMergeReason,
  autoRiskPaths,
  type CommandState,
  DEFAULT_HIGH_RISK_PATHS,
  type Decision,
  type DecisionCategory,
  type Delivery,
  highRiskProducts,
  listNeedsYou,
  mergePlan,
  setCardSensitive,
  setProjectPreferences,
  systemConfirmMerge,
  systemMergeBlockers,
  updateCard,
  type WorkItem,
} from "../index.js";
import { cardMergeCandidates } from "../merge-candidates.js";
import { CommandDraft } from "./core.js";
import { mergeNeedsHuman } from "./delegation.js";
import { notices } from "./notices.js";
import { reviewRound } from "./review-round.js";
import {
  pathEvidence,
  system,
  systemMergeFixture,
} from "./system-merge/test-fixtures.js";
import { human, id, value } from "./test-fixtures.js";

async function lite(version?: number) {
  const fixture = await systemMergeFixture();
  const { f } = fixture;
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [
        ...f.state.cards.map((c) => ({
          collection: "cards" as const,
          entity: { ...c, flow_version: version ?? 1 },
        })),
        ...f.state.decisions.map((q) => ({
          collection: "decisions" as const,
          entity: { ...q, decider: "human" as const },
        })),
      ],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  f.commit(setProjectPreferences(f.state, human, { auto_merge: "on" }, f.io));
  const q = f.state.decisions.findLast(
    (q) => q.trigger === "merge_confirmation",
  );
  if (!q) throw new Error("Missing system binding");
  return { ...fixture, q };
}

test.each([undefined, 1, 2, 3, 4, 5, 999])(
  "B2: explicit human switch applies to in-flight flow %s without opening another rollout level",
  async (version) => {
    const { f, q, check } = await lite(version);
    expect(q.decider).toBe("system");
    expect(
      systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io).ok,
    ).toBe(false);
    check();
    f.commit(systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io));
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    const needs = value(listNeedsYou(f.state, human)).data;
    expect(needs.decisions).toEqual([]);
    expect(notices(f.state).some((n) => n.decision_id === q.id)).toBe(true);
    expect(f.state.cards[0]?.flow_version).toBe(version ?? 1);
    expect(f.state.events.some((e) => e.type === "system_merge_pending")).toBe(
      true,
    );
  },
);

test.each([1, 4])(
  "B2: default off, human-only validation, audit and non-resurrecting revocation (flow %s)",
  async (version) => {
    const { f, q, check } = await lite(version);
    expect(autoMergeOn()).toBe(false);
    for (const actor of [system, f.actor(f.coder), f.actor(f.pm)])
      expect(
        setProjectPreferences(f.state, actor, { auto_merge: "off" }, f.io).ok,
      ).toBe(false);
    check();
    f.commit(systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io));
    f.commit(
      setProjectPreferences(f.state, human, { auto_merge: "off" }, f.io),
    );
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    expect(f.state.decisions.find((v) => v.id === q.id)?.status).toBe(
      "superseded",
    );
    expect(
      f.state.events
        .filter((e) => e.type === "project_preferences_updated")
        .at(-1)?.actor.kind,
    ).toBe("human");
  },
);

test("B2: audit, pause, current checklists, verifier passes and exact completion remain mandatory", async () => {
  const { f, q, check } = await lite(1);
  check();
  const confirm = (s: CommandState) =>
    systemConfirmMerge(s, system, { decision_id: q.id }, f.io).ok;
  expect(
    confirm({
      ...f.state,
      events: f.state.events.filter(
        (e) =>
          !(
            e.type === "project_preferences_updated" &&
            (e.payload as { preference?: string }).preference === "auto_merge"
          ),
      ),
    }),
  ).toBe(false);
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: true }, f.io),
  );
  expect(confirm(f.state)).toBe(false);
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: false }, f.io),
  );
  expect(confirm(f.state)).toBe(true);
  const pending = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      pre_merge_checks: [
        {
          label: "Human check",
          status: "pending" as const,
          updated_by: "human" as const,
          updated_at: "2026-01-01",
        },
      ],
    })),
  };
  expect(confirm(pending)).toBe(false);
  expect(confirm({ ...f.state, reviews: [] })).toBe(false);
  expect(
    confirm({
      ...f.state,
      deliveries: f.state.deliveries.map((v) =>
        v.kind === "card_completion"
          ? { ...v, status: "superseded" as const }
          : v,
      ),
    }),
  ).toBe(false);
});

test("B2: manual sensitive card always returns to a real human", async () => {
  const { f, q, check } = await lite(1);
  check();
  f.commit(systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io));
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(
    f.state.decisions.findLast((q) => q.trigger === "merge_confirmation")
      ?.decider,
  ).toBe("human");
});

test.each([
  "spending",
  "account",
  "credential",
  "data_deletion",
  "publish",
  "permission",
  "scope_change",
  "general",
] as DecisionCategory[])(
  "B1: merge classification uses the mandatory categories (%s)",
  async (category) => {
    const { f, q } = await lite(1);
    const { trigger: _trigger, ...other } = q;
    const source = {
      ...other,
      id: id("decision", 9000),
      category,
      status: "resolved" as const,
    };
    expect(!!mergeNeedsHuman([source], f.state.cards, f.card.id)).toBe(
      [
        "spending",
        "account",
        "credential",
        "data_deletion",
        "publish",
      ].includes(category),
    );
  },
);

test.each([
  "packages/store/migrations/0035.sql",
  "deploy/mobile-signing/worker.py",
  "apps/server/src/mobile-signing.ts",
  "apps/server/src/publish-artifact.ts",
  "apps/server/src/publication-target.ts",
  "packages/mcp-server/src/tools/publish-artifact.ts",
  "packages/domain/src/artifact-publication.ts",
  "packages/mcp-server/src/tools/mobile-signing.ts",
  "packages/host/src/deployment.ts",
  "packages/runtime-herdr/src/agent-ssh.ts",
  ".github/workflows/check.yml",
  "packages/store/src/tokens.ts",
  "packages/host/src/github-check-executor.ts",
  "packages/git-service/src/review-equivalence.ts",
])(
  "B3: default high-risk path %s is based on trusted delivery differences",
  async (path) => {
    const { f, product } = await lite(1);
    const state = {
      ...f.state,
      deliveries: f.state.deliveries.map((v) =>
        v.id === product.id ? { ...v, evidence: pathEvidence([path]) } : v,
      ),
    };
    expect(highRiskProducts(state, f.card).map((w) => w.id)).toEqual([
      product.work_item_id,
    ]);
    expect(DEFAULT_HIGH_RISK_PATHS.length).toBeGreaterThan(5);
  },
);

test("B3: tags classify; human marker and configured paths require independent review", async () => {
  const { f, product } = await lite(1);
  const state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      risk_tags: ["security", "permission", "numeric_rule"] as const,
    })),
  };
  expect(highRiskProducts(state, state.cards[0]!)).toEqual([]);
  expect(
    updateCard(
      f.state,
      f.actor(f.pm),
      { card_id: f.card.id, high_risk: true },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    highRiskProducts(
      {
        ...state,
        deliveries: state.deliveries.map((v) =>
          v.id === product.id
            ? { ...v, evidence: pathEvidence([".github/a.yml"]) }
            : v,
        ),
      },
      f.card,
    ),
  ).toHaveLength(1);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { high_risk_paths: ["packages/domain/**"] },
      f.io,
    ),
  );
  expect(highRiskProducts(f.state, f.card)).toHaveLength(1);
  expect(
    setProjectPreferences(
      f.state,
      f.actor(f.coder),
      { high_risk_paths: [] },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    setProjectPreferences(
      f.state,
      human,
      { high_risk_paths: ["../escape"] },
      f.io,
    ).ok,
  ).toBe(false);
});

test("B4: only rejects consume the lifetime review budget", async () => {
  const { f } = await lite(1);
  const review = f.state.reviews[0];
  if (!review) throw new Error("Missing review");
  const item = f.state.work_items.find((w) => w.id === review.work_item_id);
  if (!item) throw new Error("Missing verifier");
  for (const verdict of ["pass", "conditional", "reject"] as const) {
    const state = {
      ...f.state,
      reviews: [1, 2, 3].map((n) => ({
        ...review,
        id: id("review", n),
        verdict,
      })),
    };
    expect(
      reviewRound(
        new CommandDraft(state, system, "system_confirm_merge", f.io),
        item,
      ),
    ).toBe(verdict === "reject" ? 4 : 1);
  }
});

test("B2: optional pending review does not add a gate, while any outstanding must_fix still blocks", async () => {
  const { f, q, check } = await lite(1);
  check();
  const item = f.state.work_items.find(
    (w) => w.kind === "verify" && w.target_work_item_id,
  );
  if (!item) throw new Error("Missing verifier");
  const optional = {
    ...item,
    id: id("work_item", 900),
    required: false,
    status: "ready" as const,
  };
  const state = { ...f.state, work_items: [...f.state.work_items, optional] };
  expect(
    systemConfirmMerge(state, system, { decision_id: q.id }, f.io).ok,
  ).toBe(true);
  const review = f.state.reviews[0];
  if (!review) throw new Error("Missing review");
  const blocked = {
    ...state,
    reviews: [
      ...state.reviews,
      {
        ...review,
        id: id("review", 900),
        work_item_id: optional.id,
        verdict: "reject" as const,
        issues: [
          {
            severity: "major" as const,
            description: "Outstanding defect",
            impact: "functional" as const,
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
    ],
  };
  expect(
    systemConfirmMerge(blocked, system, { decision_id: q.id }, f.io).ok,
  ).toBe(false);
});

test("B2: explicitly turning off a previously unset switch revokes a legacy A3 authorization", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  f.commit(systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io));
  f.commit(setProjectPreferences(f.state, human, { auto_merge: "off" }, f.io));
  expect(f.state.project_preferences?.[0]?.auto_merge).toBe("off");
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(
    systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io).ok,
  ).toBe(false);
});

test.each(["delegated", "pm_office_chat"] as const)(
  "B2: an old already confirmed merge migrates to fresh system authority (%s)",
  async (via) => {
    const { f, q, check } = await systemMergeFixture();
    check();
    const oldResolution: NonNullable<Decision["resolution"]> = {
      option: "merge",
      resolved_by: `assignment:${id("assignment", 900)}` as const,
      via,
      rationale: "Legacy confirmation",
      raw_quote: "Approved",
      via_chain: [],
      at: "2026-01-01T00:00:00Z",
    };
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [
          ...f.state.cards.map((c) => ({
            collection: "cards" as const,
            entity: { ...c, flow_version: 1 },
          })),
          {
            collection: "decisions",
            entity: {
              ...q,
              decider: "role:pm",
              status: "resolved",
              resolution: oldResolution,
            },
          },
        ],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
    f.commit(setProjectPreferences(f.state, human, { auto_merge: "on" }, f.io));
    expect(f.state.decisions.find((v) => v.id === q.id)).toMatchObject({
      status: "superseded",
      resolution: oldResolution,
    });
    const current = f.state.decisions.findLast(
      (v) => v.trigger === "merge_confirmation",
    );
    if (!current) throw new Error("Missing binding");
    expect(current).toMatchObject({ decider: "system", status: "open" });
    f.commit(
      systemConfirmMerge(f.state, system, { decision_id: current.id }, f.io),
    );
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  },
);

test.each(["valid", "stale_sha", "stale_baseline"])(
  "B3: bound own-path evidence excludes unrelated main changes and fails closed on %s",
  async (mode) => {
    const { f, product } = await lite(1);
    const evidence = pathEvidence([".github/workflows/main.yml"]);
    evidence.push({
      kind: "diff",
      details: {
        own_path_inventory: {
          version: 1,
          sha: mode === "stale_sha" ? "f".repeat(40) : product.subject.value,
          tree_sha: "c".repeat(40),
          base_sha: "d".repeat(40),
          assignment_base_sha: (mode === "stale_baseline" ? "e" : "b").repeat(
            40,
          ),
          complete: true,
          paths: ["packages/domain/src/example.ts"],
        },
      },
    });
    const state = {
      ...f.state,
      deliveries: f.state.deliveries.map((v) =>
        v.id === product.id ? { ...v, evidence } : v,
      ),
    };
    expect(highRiskProducts(state, f.card)).toHaveLength(
      mode === "valid" ? 0 : 1,
    );
    const current = state.deliveries.find((v) => v.id === product.id);
    if (!current) throw new Error("Missing delivery");
    expect(!!autoRiskPaths(current)).toBe(mode === "valid");
  },
);

test.each([
  "spending",
  "account",
  "credential",
  "data_deletion",
  "publish",
  "sensitive",
] as const)(
  "B1 supplement: %s is default-human, human-authorizable for system merge, audited and revocable before publication",
  async (category) => {
    const { f, q, check } = await lite(1);
    if (category === "sensitive")
      f.commit(
        setCardSensitive(
          f.state,
          human,
          { card_id: f.card.id, sensitive: true },
          f.io,
        ),
      );
    else {
      const { trigger: _trigger, ...other } = q;
      f.commit({
        ok: true,
        value: {
          data: null,
          changes: [
            {
              collection: "decisions",
              entity: {
                ...other,
                id: id("decision", 9000),
                key: id("decision", 9000),
                category,
                status: "resolved",
              },
            },
          ],
          events: [],
          timeline: [],
          token_requests: [],
        },
      });
    }
    check();
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    for (const actor of [system, f.actor(f.coder), f.actor(f.pm)])
      expect(
        setProjectPreferences(
          f.state,
          actor,
          { decision_delegation: { [category]: true } },
          f.io,
        ).ok,
      ).toBe(false);
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { decision_delegation: { [category]: true } },
        f.io,
      ),
    );
    const current = f.state.decisions.findLast(
      (v) => v.trigger === "merge_confirmation",
    );
    expect(current?.decider).toBe("system");
    if (!current) throw new Error("Missing current confirmation");
    f.commit(
      systemConfirmMerge(f.state, system, { decision_id: current.id }, f.io),
    );
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    expect(
      mergePlan(
        {
          ...f.state,
          events: f.state.events.filter(
            (e) =>
              (e.payload as { preference?: string }).preference !==
              "decision_delegation",
          ),
        },
        f.card.id,
      ).ok,
    ).toBe(false);
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { decision_delegation: { [category]: false } },
        f.io,
      ),
    );
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    expect(f.state.decisions.find((v) => v.id === current.id)?.status).toBe(
      "superseded",
    );
    expect(
      f.state.events.findLast(
        (e) =>
          (e.payload as { preference?: string }).preference ===
          "decision_delegation",
      )?.actor.kind,
    ).toBe("human");
  },
);

test("B1: publish authorization includes release paths in automatic merge", async () => {
  const { f, check } = await lite(1);
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: f.state.deliveries
        .filter((v) => v.kind !== "card_completion")
        .map((v) => ({
          collection: "deliveries" as const,
          entity: { ...v, evidence: pathEvidence(["release/package.json"]) },
        })),
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { decision_delegation: { publish: true } },
      f.io,
    ),
  );
  const q = f.state.decisions.findLast(
    (v) => v.trigger === "merge_confirmation",
  );
  if (!q) throw new Error("Missing current merge");
  check();
  f.commit(systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io));
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test.each([4, 5])(
  "flow %s and Flow Lite share one idempotent merge confirmation",
  async (version) => {
    const { f, q, check } = await lite(version);
    check();
    f.commit(systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io));
    const count = f.state.events.filter(
      (e) =>
        e.type === "decision_resolved" &&
        (e.payload as { decision_id?: string }).decision_id === q.id,
    ).length;
    f.commit(systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io));
    expect(
      f.state.events.filter(
        (e) =>
          e.type === "decision_resolved" &&
          (e.payload as { decision_id?: string }).decision_id === q.id,
      ),
    ).toHaveLength(count);
    expect(count).toBe(1);
    expect(
      f.state.decisions.filter(
        (v) => v.trigger === "merge_confirmation" && v.status === "resolved",
      ),
    ).toHaveLength(1);
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  },
);

const MISSING_PATH_EVIDENCE = "缺少完整的当前交付文件差异证据";

/** C-623: add an optional producer whose current output is a signed artifact. */
async function withArtifactProduct() {
  const { f, q, product, check } = await lite(5);
  check();
  const code = f.state.deliveries.find((v) => v.id === product.id);
  const item = f.state.work_items.find((w) => w.id === product.work_item_id);
  if (!code || item?.kind !== "produce")
    throw new Error("Missing code product");
  const artifactItem: WorkItem = {
    ...item,
    id: id("work_item", 900),
    title: "Signed APK",
    required: false,
    status: "accepted",
  };
  const { branch: _branch, ...source } = code;
  const artifact: Delivery = {
    ...source,
    id: id("delivery", 900),
    work_item_id: artifactItem.id,
    kind: "other",
    subject: { kind: "artifact_sha256", value: "e".repeat(64) },
    evidence: [],
    requested_verifiers: [],
    status: "accepted",
  };
  const state: CommandState = {
    ...f.state,
    work_items: [...f.state.work_items, artifactItem],
    deliveries: [...f.state.deliveries, artifact],
  };
  return { f, q, state, code, artifact };
}

test("C-623: artifact products need no path evidence; a code+artifact card merges by system", async () => {
  const { f, q, state, code } = await withArtifactProduct();
  expect(systemMergeBlockers(state, q)).not.toContain(MISSING_PATH_EVIDENCE);
  expect(autoRiskMergeReason(state, f.card.id)).toBeUndefined();
  // Only the Git product is merged; the artifact never reaches the repository.
  expect(cardMergeCandidates(state, f.card).map((c) => c.delivery_id)).toEqual([
    code.id,
  ]);
  const merged = systemConfirmMerge(state, system, { decision_id: q.id }, f.io);
  expect(merged.ok).toBe(true);
});

test("C-623: a code product without path evidence still blocks next to an artifact", async () => {
  const { f, q, state, code } = await withArtifactProduct();
  const missing = {
    ...state,
    deliveries: state.deliveries.map((v) =>
      v.id === code.id ? { ...v, evidence: [] } : v,
    ),
  };
  expect(systemMergeBlockers(missing, q)).toContain(MISSING_PATH_EVIDENCE);
  expect(autoRiskMergeReason(missing, f.card.id)).toContain("交人");
  expect(
    systemConfirmMerge(missing, system, { decision_id: q.id }, f.io).ok,
  ).toBe(false);
});

test("C-623: a live producer with no current delivery stays unknown and blocks", async () => {
  const { f, q, state, artifact } = await withArtifactProduct();
  const empty = {
    ...state,
    deliveries: state.deliveries.filter((v) => v.id !== artifact.id),
  };
  expect(systemMergeBlockers(empty, q)).toContain(MISSING_PATH_EVIDENCE);
  expect(autoRiskMergeReason(empty, f.card.id)).toContain("交人");
});

test("C-623: a pure artifact card has nothing to merge and no evidence gate", async () => {
  const { f, state, code } = await withArtifactProduct();
  const pure = {
    ...state,
    deliveries: state.deliveries.map((v) =>
      v.id === code.id
        ? {
            ...v,
            kind: "other" as const,
            subject: {
              kind: "artifact_sha256" as const,
              value: "f".repeat(64),
            },
            evidence: [],
          }
        : v,
    ),
  };
  // No Git product: completion ends as merge_not_required, never a confirmation.
  expect(cardMergeCandidates(pure, f.card)).toEqual([]);
  expect(autoRiskMergeReason(pure, f.card.id)).toBeUndefined();
  expect(highRiskProducts(pure, f.card)).toEqual([]);
});
