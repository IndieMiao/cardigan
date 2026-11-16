import { expect, test } from "vitest";
import {
  applyAutoRiskTags,
  autoRiskMergeReason,
  autoRiskPaths,
  autoSecurityPaths,
  type CommandState,
  type DeliveryEvidence,
  displayChangedPath,
  mergePathMatches,
  mergePlan,
  prepareDelivery,
  type SubmitDeliveryParams,
  setProjectPreferences,
  submitDelivery,
  updateCard,
  validMergePathList,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const params: SubmitDeliveryParams = {
  work_item_id: id("work_item", 1),
  kind: "code",
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2)],
};
function evidence(paths: readonly string[]): DeliveryEvidence[] {
  const binding = {
    sha: subject.value,
    base_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  return [
    {
      kind: "diff",
      details: {
        role_rule_inventory: {
          version: 1,
          complete: true,
          ...binding,
          changes: paths.map((path) => ({ path, status: "M" })),
        },
      },
    },
    { kind: "commit", details: binding },
  ];
}
async function deliver(
  state = fixture(),
  facts = evidence([".github/workflows/ci.yml"]),
) {
  const io = ports();
  const input = {
    ...params,
    requested_verifiers: state.work_items
      .filter(
        (w) =>
          w.kind === "verify" &&
          w.target_work_item_id === params.work_item_id &&
          w.required,
      )
      .map((w) => w.id),
  };
  const proof = value(
    await prepareDelivery(state, actor(), input, {
      verify: async () => ({ ok: true, value: facts }),
    }),
  );
  const effect = value(submitDelivery(state, actor(), input, proof, io));
  return { state: apply(state, effect), effect, io };
}

test.each([
  ".github/workflows/ci.yml",
  "packages/store/migrations/0031.sql",
  "packages/host/src/deployment.ts",
  "packages/host/src/deployment-config.ts",
  "packages/host/src/deployment-node.ts",
  "packages/host/src/deployment-recovery.ts",
  "apps/cli/src/self-deploy.ts",
])(
  "D6: product touching %s adds security atomically with system audit",
  async (path) => {
    const { state, effect, io } = await deliver(fixture(), evidence([path]));
    expect(state.cards.find((c) => c.id === id("card", 1))?.risk_tags).toEqual([
      "security",
    ]);
    const event = effect.events.find(
      (e) => e.type === "auto_risk_tags_applied",
    );
    expect(event).toMatchObject({
      actor: system,
      payload: {
        delivery_id: effect.data.id,
        matched_paths: [path],
        needs_independent_reviewer: true,
      },
    });
    expect(effect.events.some((e) => e.type === "delivery_submitted")).toBe(
      true,
    );
    expect(
      effect.timeline.find((e) => e.type === "system" && e.body.includes(path)),
    ).toMatchObject({
      author: "system",
      body: expect.stringContaining(path),
    });
    expect(
      value(
        applyAutoRiskTags(state, system, { delivery_id: effect.data.id }, io),
      ).events,
    ).toEqual([]);
    expect(
      state.work_items.some((w) => w.role_id === "independent_reviewer"),
    ).toBe(false);
    const completion = {
      ...params,
      kind: "card_completion" as const,
      plain_summary: {
        changed: "修改了测试功能",
        impact: "测试影响",
        risk: "无",
      },
      requested_verifiers: [id("work_item", 3)],
    };
    expect(
      await prepareDelivery(state, actor(), completion, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invariant_violation",
        message: expect.stringContaining("independent_reviewer"),
      },
    });
  },
);

test("D6: keeps other risk tags, existing security is a no-op, existing required reviewer suppresses PM request", async () => {
  const base = fixture();
  const verifier = base.work_items[1];
  if (!verifier) throw new Error("Missing fixture verifier");
  const state = {
    ...base,
    cards: base.cards.map((c) => ({
      ...c,
      risk_tags: ["permission" as const],
    })),
    work_items: [
      ...base.work_items,
      {
        ...verifier,
        id: id("work_item", 4),
        role_id: "independent_reviewer",
        assignment_id: undefined,
      },
    ],
  } as CommandState;
  const { effect, state: tagged } = await deliver(state);
  expect(tagged.cards.find((c) => c.id === id("card", 1))?.risk_tags).toEqual([
    "permission",
    "security",
  ]);
  expect(
    effect.events.find((e) => e.type === "auto_risk_tags_applied")?.payload,
  ).toMatchObject({ needs_independent_reviewer: false });
  const already = {
    ...base,
    cards: base.cards.map((c) => ({ ...c, risk_tags: ["security" as const] })),
  };
  const result = await deliver(already);
  expect(
    result.effect.events.some((e) => e.type === "auto_risk_tags_applied"),
  ).toBe(false);
});

test.each([
  "packages/host/src/deployment/file.ts",
  "packages/host/src/not-deployment.ts",
  ".github-other/ci.yml",
  "apps/cli/src/self-deploy.ts.bak",
])("D6: path boundary %s does not match", async (path) => {
  const { state } = await deliver(fixture(), evidence([path]));
  expect(
    state.cards.find((c) => c.id === id("card", 1))?.risk_tags,
  ).toBeUndefined();
});

test("D6: human can remove optional defaults and add custom paths; mandatory .github remains", async () => {
  const base = fixture(),
    io = ports();
  const paths = [".github/**", "secrets/config*"];
  const state = apply(
    base,
    value(
      setProjectPreferences(base, human, { auto_security_paths: paths }, io),
    ),
  );
  expect(
    (
      await deliver(state, evidence(["packages/store/migrations/new.sql"]))
    ).state.cards.find((c) => c.id === id("card", 1))?.risk_tags,
  ).toBeUndefined();
  expect(
    (await deliver(state, evidence(["secrets/config.json"]))).state.cards.find(
      (c) => c.id === id("card", 1),
    )?.risk_tags,
  ).toEqual(["security"]);
  expect(autoSecurityPaths()).toContain("packages/host/src/deployment*");
  for (const auto_security_paths of [
    [],
    ["packages/**"],
    [".github/**", "a/*/b"],
  ])
    expect(
      setProjectPreferences(base, human, { auto_security_paths }, io).ok,
    ).toBe(false);
  expect(
    setProjectPreferences(
      base,
      actor(4, "pm"),
      { auto_security_paths: paths },
      io,
    ).ok,
  ).toBe(false);
});

test("D6/F0: saving either human preference preserves the other and validates the patch atomically", async () => {
  const base = fixture(),
    io = ports();
  const paths = [".github/**", "custom/config*"];
  const saved = value(
    setProjectPreferences(
      base,
      human,
      { flow_version: 1, auto_security_paths: paths },
      io,
    ),
  );
  expect(saved.data).toMatchObject({
    flow_version: 1,
    auto_security_paths: paths,
  });
  const state = apply(base, saved);
  const unchangedFlow = value(
    setProjectPreferences(state, human, { flow_version: 1 }, io),
  );
  expect(unchangedFlow.data.auto_security_paths).toEqual(paths);
  expect(unchangedFlow.events).toEqual([]);
  expect(
    setProjectPreferences(
      state,
      human,
      { flow_version: 6, auto_security_paths: [".github/**"] },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const delivered = await deliver(state, evidence(["custom/config.json"]));
  expect(
    delivered.state.cards.find((c) => c.id === id("card", 1))?.risk_tags,
  ).toEqual(["security"]);
});

test("D6: human/PM retain audited removal, producer cannot remove tags or call the system command", async () => {
  const { state, effect, io } = await deliver();
  for (const caller of [human, actor(), actor(4, "pm")])
    expect(
      applyAutoRiskTags(state, caller, { delivery_id: effect.data.id }, io),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(
    updateCard(state, actor(), { card_id: id("card", 1), risk_tags: [] }, io)
      .ok,
  ).toBe(false);
  for (const caller of [human, actor(4, "pm")]) {
    const removed = value(
      updateCard(state, caller, { card_id: id("card", 1), risk_tags: [] }, io),
    );
    expect(removed.events[0]?.payload).toMatchObject({
      previous_risk_tags: ["security"],
      risk_tags: [],
    });
  }
  expect(
    applyAutoRiskTags(
      state,
      { ...system, project_id: "other" },
      { delivery_id: effect.data.id },
      io,
    ).ok,
  ).toBe(false);
});

test.each(
  (
    [
      [],
      evidence(["../.github/ci.yml"]),

      evidence([".github/ci.yml"]).slice(0, 1),
      [
        {
          kind: "diff",
          details: {
            role_rule_inventory: { version: 1, complete: false, changes: [] },
          },
        },
      ],
      [{ kind: "diff", details: { role_rule_inventory: null } }],
    ] satisfies DeliveryEvidence[][]
  ).map((facts) => ({ facts })),
)(
  "D6: missing, malformed, incomplete or invalid paths stay unknown (%j)",
  async ({ facts }) => {
    const { state, effect } = await deliver(fixture(), facts);
    expect(
      state.cards.find((c) => c.id === id("card", 1))?.risk_tags,
    ).toBeUndefined();
    expect(autoRiskPaths(effect.data)).toBeUndefined();
    expect(autoRiskMergeReason(state, id("card", 1))).toBeUndefined();
    const newer = {
      ...state,
      cards: state.cards.map((c) => ({ ...c, flow_version: 4 })),
    };
    expect(autoRiskMergeReason(newer, id("card", 1))).toContain("交人");
  },
);

test("D6: complete empty evidence is known, binding mismatches are unknown, only latest product counts", async () => {
  const { state, effect } = await deliver(fixture(), evidence([]));
  expect(autoRiskPaths(effect.data)).toEqual([]);
  const newer = {
    ...state,
    cards: state.cards.map((c) => ({ ...c, flow_version: 4 })),
  };
  expect(autoRiskMergeReason(newer, id("card", 1))).toBeUndefined();
  for (const key of ["sha", "base_sha", "tree_sha"]) {
    const bad = JSON.parse(JSON.stringify(effect.data)) as typeof effect.data;
    const commit = bad.evidence[1]?.details as Record<string, string>;
    commit[key] = "d".repeat(40);
    expect(autoRiskPaths(bad)).toBeUndefined();
  }
  expect(
    autoRiskMergeReason(
      {
        ...newer,
        deliveries: [
          ...state.deliveries,
          {
            ...effect.data,
            id: id("delivery", 9999),
            evidence: [],
          },
        ],
      },
      id("card", 1),
    ),
  ).toContain("交人");
});

test.each(
  [".github/workflows/ci.yml", "packages/store/migrations/new.sql"].flatMap(
    (sensitive) =>
      [
        "docs/a b.md",
        "web/app/[id]/page.tsx",
        "notes/what?.md",
        "notes/{draft}*.md",
        "notes/a\\b.md",
      ].map((companion) => ({ sensitive, companion })),
  ),
)(
  "D6: literal companion $companion cannot hide $sensitive",
  async ({ sensitive, companion }) => {
    const { state, effect } = await deliver(
      fixture(),
      evidence([sensitive, companion]),
    );
    expect(state.cards.find((c) => c.id === id("card", 1))?.risk_tags).toEqual([
      "security",
    ]);
    expect(autoRiskPaths(effect.data)).toEqual([sensitive, companion]);
    expect(
      effect.events.find((e) => e.type === "auto_risk_tags_applied")?.payload,
    ).toMatchObject({
      matched_paths: [sensitive],
      path_evidence_complete: true,
      needs_independent_reviewer: true,
    });
    const newer = {
      ...state,
      cards: state.cards.map((c) => ({ ...c, flow_version: 4 })),
    };
    expect(autoRiskMergeReason(newer, id("card", 1))).toBeUndefined();
    const completion = {
      ...params,
      kind: "card_completion" as const,
      plain_summary: {
        changed: "修改了测试功能",
        impact: "测试影响",
        risk: "无",
      },
      requested_verifiers: [id("work_item", 3)],
    };
    expect(
      await prepareDelivery(state, actor(), completion, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invariant_violation",
        message: expect.stringContaining("independent_reviewer"),
      },
    });
  },
);

test.each(["/invalid", "a/../b", "a//b", ".", "", "a/zero\u0000byte"])(
  "D6: malformed companion %j preserves a known security match and keeps evidence uncertain",
  async (companion) => {
    const { state, effect } = await deliver(
      fixture(),
      evidence([".github/ci.yml", companion]),
    );
    expect(state.cards.find((c) => c.id === id("card", 1))?.risk_tags).toEqual([
      "security",
    ]);
    expect(autoRiskPaths(effect.data)).toBeUndefined();
    expect(
      effect.events.find((e) => e.type === "auto_risk_tags_applied")?.payload,
    ).toMatchObject({
      matched_paths: [".github/ci.yml"],
      path_evidence_complete: false,
    });
    expect(
      effect.timeline.some((e) => e.body.includes("其余路径证据无法完整判读")),
    ).toBe(true);
    const newer = {
      ...state,
      cards: state.cards.map((c) => ({ ...c, flow_version: 4 })),
    };
    expect(autoRiskMergeReason(newer, id("card", 1))).toContain("交人");
  },
);

test.each(["a*", "a/b*", "a/b", "a/**", ".github/**"])(
  "D6: supported pattern %s",
  (p) => expect(validMergePathList([p])).toBe(true),
);

test.each(
  ["\t", "\n", "\r", "\u001b", "\u007f", "\u0085"].flatMap((control) =>
    [
      `.github/workflows/ci${control}name.yml`,
      `packages/store/migrations/new${control}.sql`,
      `packages/host/src/deployment${control}.ts`,
    ].map((path) => ({ path })),
  ),
)(
  "D6: a single control-character filename $path triggers security with escaped display",
  async ({ path }) => {
    const { state, effect, io } = await deliver(fixture(), evidence([path]));
    expect(state.cards.find((c) => c.id === id("card", 1))?.risk_tags).toEqual([
      "security",
    ]);
    expect(autoRiskPaths(effect.data)).toEqual([path]);
    const event = effect.events.find(
      (e) => e.type === "auto_risk_tags_applied",
    );
    expect(event?.payload).toMatchObject({
      matched_paths: [path],
      path_evidence_complete: true,
      needs_independent_reviewer: true,
    });
    const entry = effect.timeline.find((e) => e.event_seq === event?.seq);
    expect(entry?.body).toContain(displayChangedPath(path));
    expect(entry?.body).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
    expect(JSON.parse(displayChangedPath(path))).toBe(path);
    expect(
      value(
        applyAutoRiskTags(state, system, { delivery_id: effect.data.id }, io),
      ).events,
    ).toEqual([]);
    const newer = {
      ...state,
      cards: state.cards.map((c) => ({ ...c, flow_version: 4 })),
    };
    expect(autoRiskMergeReason(newer, id("card", 1))).toBeUndefined();
    const completion = {
      ...params,
      kind: "card_completion" as const,
      plain_summary: {
        changed: "修改了测试功能",
        impact: "测试影响",
        risk: "无",
      },
      requested_verifiers: [id("work_item", 3)],
    };
    expect(
      await prepareDelivery(state, actor(), completion, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invariant_violation",
        message: expect.stringContaining("independent_reviewer"),
      },
    });
  },
);

test("D6: display quoting preserves literal names and escapes line separators", () => {
  for (const path of [
    '.github/"quoted"\\file.yml',
    ".github/a\u2028b\u2029c.yml",
  ]) {
    const display = displayChangedPath(path);
    expect(JSON.parse(display)).toBe(path);
    expect(display).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
  }
});
test.each([
  "*",
  "a/*",
  "a*b",
  "a**",
  "a/*/b",
  "a/**/b",
  "a/../b*",
  "/a*",
  "a\\b*",
  "a/",
  "a?",
  "a[0]",
  "a/***",
  "a*\n",
  "a\u0000b",
])("D6: rejects unsupported pattern %j", (p) =>
  expect(validMergePathList([p])).toBe(false),
);
test("D6: literal, directory and filename-prefix matching boundaries", () => {
  expect(mergePathMatches("a/b.ts", "a/b.ts")).toBe(true);
  expect(mergePathMatches("a/b.ts/more", "a/b.ts")).toBe(false);
  expect(mergePathMatches("a/b/deep/file", "a/b/**")).toBe(true);
  expect(mergePathMatches("a/bad", "a/b/**")).toBe(false);
  expect(mergePathMatches("a/b.ts", "a/b*")).toBe(true);
  expect(mergePathMatches("a/b/deep", "a/b*")).toBe(false);
});

test.each([1, 4])(
  "D6: flow %i with missing evidence retains the intended auto-policy boundary",
  async (flow_version) => {
    const f = mergeFixture("auto");
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [{ collection: "cards", entity: { ...f.card, flow_version } }],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
    await f.accept();
    const confirmation = f.state.decisions.find(
      (q) => q.trigger === "merge_confirmation",
    );
    if (flow_version === 1) {
      expect(confirmation).toBeUndefined();
      expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    } else {
      expect(confirmation).toMatchObject({
        decider: "human",
        human_required_reason: expect.stringContaining("证据"),
      });
      expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    }
  },
);

test("D6: adding security invalidates an ineligible pending delegated merge in the same effect", async () => {
  const f = mergeFixture();
  const { product } = await f.accept();
  const state = {
    ...f.state,
    deliveries: f.state.deliveries.map((v) =>
      v.id === product.id
        ? { ...v, evidence: evidence([".github/ci.yml"]) }
        : v,
    ),
    decisions: f.state.decisions.map((q) => ({
      ...q,
      decider: "role:pm" as const,
    })),
  };
  const effect = value(
    applyAutoRiskTags(state, system, { delivery_id: product.id }, f.io),
  );
  expect(effect.changes).toContainEqual(
    expect.objectContaining({
      collection: "cards",
      entity: expect.objectContaining({ risk_tags: ["security"] }),
    }),
  );
  expect(effect.changes).toContainEqual(
    expect.objectContaining({
      collection: "decisions",
      entity: expect.objectContaining({
        decider: "human",
        context: expect.stringContaining("风险标签"),
      }),
    }),
  );
});
