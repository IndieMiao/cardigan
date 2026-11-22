import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { registerTemplateRoles } from "./template-fixtures.js";

const project = "p-card-update" as ProjectId;
let dataDir: string;
let store: Store;
let output: string[];
let errors: string[];
let io: CliIo;

async function run(args: string[]): Promise<number> {
  output = [];
  errors = [];
  return main(args, io);
}

async function createCard(projectId = project): Promise<void> {
  const setup = Store.open({ dataDir });
  try {
    registerTemplateRoles(setup, projectId);
  } finally {
    setup.close();
  }
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Original title",
      "--goal",
      "Original goal",
      "--acceptance",
      "Original criterion",
      "--repo",
      "example/repo",
      "--project",
      projectId,
    ]),
  ).toBe(0);
}

const snapshot = (projectId = project) =>
  store.uow.read((tx) => loadCommandState(tx, projectId));

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-card-update-"));
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("card commands must not spawn");
    },
    captureCommand: async () => {
      throw new Error("card commands must not spawn");
    },
  };
  expect(await run(["project", "create", project])).toBe(0);
  await createCard();
  store = Store.open({ dataDir });
});

afterEach(() => {
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("updates text and acceptance criteria as human, preserving other fields", async () => {
  const before = snapshot();
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--title=新标题=x=y",
      "--goal",
      " 新目标 ",
      "--acceptance",
      " 标准一 ; ; 标准二; ",
    ]),
  ).toBe(0);
  const after = snapshot();
  expect(after.cards[0]).toEqual({
    ...before.cards[0],
    title: "新标题=x=y",
    goal: "新目标",
    acceptance_criteria: ["标准一", "标准二"],
  });
  expect(after.work_items).toEqual(before.work_items);
  expect(after.events.at(-1)).toMatchObject({
    type: "card_updated",
    actor: { kind: "human", project_id: project },
  });
  expect(after.timeline.at(-1)?.author).toBe("human");
  expect(output.join("\n")).toBe("已更新卡片 C-1：title、goal、acceptance");
});

test("independent review conclusions cannot be injected through CLI card updates", async () => {
  const before = snapshot();
  for (const status of ["passed", "failed"])
    for (const flag of ["--pre-merge-check", "--pre-merge-checks"]) {
      const check = { label: "独立复核", status };
      expect(
        await run([
          "card",
          "update",
          "C-1",
          "--title",
          "valid",
          flag,
          JSON.stringify(flag === "--pre-merge-check" ? check : [check]),
        ]),
      ).toBe(2);
      expect(errors.join("\n")).toContain("不认识的选项");
      expect(snapshot()).toEqual(before);
    }
});

test("--deadline sets a calendar date or clears it with none", async () => {
  const update = (date: string) =>
    run(["card", "update", "C-1", "--deadline", date]);
  expect(await update("2028-02-29")).toBe(0);
  expect(snapshot().cards[0]?.deadline).toBe("2028-02-29");
  for (const invalid of ["", "2026-02-29", "tomorrow"]) {
    expect(await update(invalid)).toBe(2);
    expect(snapshot().cards[0]?.deadline).toBe("2028-02-29");
  }
  expect(await update("none")).toBe(0);
  const after = snapshot();
  expect(after.cards[0]).not.toHaveProperty("deadline");
  expect(after.timeline.at(-1)).toMatchObject({
    author: "human",
    body: expect.stringContaining("截止日期已清除"),
  });
});

test("updates named priority and planning states including none", async () => {
  for (const [status, priority, rank] of [
    ["backlog", "urgent", 4],
    ["todo", "无", 0],
  ] as const) {
    expect(
      await run([
        "card",
        "update",
        "C-1",
        "--status",
        status,
        "--priority",
        priority,
      ]),
    ).toBe(0);
    expect(snapshot().cards[0]).toMatchObject({
      status,
      priority: rank,
    });
    expect(output.join("\n")).toBe("已更新卡片 C-1：priority、status");
  }
});

test("sets, deduplicates and clears risk tags through the update_card gate", async () => {
  const before = snapshot();
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--risk-tags",
      " security, numeric_rule ,security",
    ]),
  ).toBe(0);
  let after = snapshot();
  expect(after.cards[0]).toEqual({
    ...before.cards[0],
    risk_tags: ["security", "numeric_rule"],
  });
  expect(after.events.at(-1)).toMatchObject({
    type: "card_updated",
    actor: { kind: "human", project_id: project },
    payload: {
      previous_risk_tags: [],
      risk_tags: ["security", "numeric_rule"],
    },
  });
  expect(output.join("\n")).toBe("已更新卡片 C-1：risk-tags");
  expect(await run(["card", "update", "C-1", "--risk-tags=none"])).toBe(0);
  after = snapshot();
  expect(after.cards[0]?.risk_tags).toEqual([]);
  expect(after.events.at(-1)).toMatchObject({
    type: "card_updated",
    payload: {
      previous_risk_tags: ["security", "numeric_rule"],
      risk_tags: [],
    },
  });
});

test("cancels unfinished work, preserves passed verification and other cards", async () => {
  await createCard();
  store.uow.run((tx) => {
    for (const item of tx.work_items.list(project)) {
      if (item.id === "W-1")
        tx.work_items.put(project, { ...item, status: "in_progress" });
      if (item.kind === "verify" && item.id === "W-2")
        tx.work_items.put(project, { ...item, status: "passed" });
    }
  });
  const before = snapshot();
  expect(await run(["card", "update", "C-1", "--status", "cancelled"])).toBe(0);
  const after = snapshot();
  expect(after.cards.find((card) => card.id === "C-1")?.status).toBe(
    "cancelled",
  );
  expect(
    after.work_items
      .filter((item) => item.card_id === "C-1")
      .map((item) => [item.id, item.status]),
  ).toEqual([
    ["W-1", "cancelled"],
    ["W-2", "passed"],
    ["W-3", "cancelled"],
  ]);
  expect(after.cards.find((card) => card.id === "C-2")).toEqual(
    before.cards.find((card) => card.id === "C-2"),
  );
  expect(after.work_items.filter((item) => item.card_id === "C-2")).toEqual(
    before.work_items.filter((item) => item.card_id === "C-2"),
  );
  expect(output.join("\n")).toBe("已更新卡片 C-1：status");
});

test.each([
  ["done", "todo"],
  ["done", "backlog"],
  ["in_progress", "backlog"],
] as const)(
  "rejects %s → %s in Chinese without partial changes",
  async (from, to) => {
    store.uow.run((tx) => {
      const card = tx.cards.list(project)[0];
      if (!card) throw new Error("missing fixture card");
      tx.cards.put(project, { ...card, status: from });
    });
    const before = snapshot();
    expect(
      await run([
        "card",
        "update",
        "C-1",
        "--title",
        "Must roll back",
        "--status",
        to,
      ]),
    ).toBe(2);
    expect(errors.join("\n")).toContain(
      `无法更新卡片 C-1：不允许从 ${from} 转为 ${to}`,
    );
    expect(output).toEqual([]);
    expect(snapshot()).toEqual(before);
  },
);

test("rejects cancelling done cards with a Chinese recovery instruction and no partial changes", async () => {
  store.uow.run((tx) => {
    const card = tx.cards.list(project)[0];
    if (!card) throw new Error("missing fixture card");
    tx.cards.put(project, { ...card, status: "done", resolution: "done" });
    for (const item of tx.work_items.list(project)) {
      tx.work_items.put(
        project,
        item.kind === "produce"
          ? { ...item, status: "accepted" }
          : { ...item, status: "passed" },
      );
    }
  });
  const before = snapshot();
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--title",
      "Must roll back",
      "--status",
      "cancelled",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("已完成卡片不能取消");
  expect(errors.join("\n")).toContain("请建新卡");
  expect(errors.join("\n")).toContain("--superseded-by <C-m>");
  expect(snapshot()).toEqual(before);
});

test.each([
  { args: [], message: "至少提供一个" },
  { args: ["--project", project], message: "至少提供一个" },
  ...["done", "in_progress", "review", "awaiting_merge", "invalid"].map(
    (status) => ({
      args: ["--title", "Must not persist", "--status", status],
      message: "--status 只接受",
    }),
  ),
  { args: ["--title", ""], message: "缺少 --title" },
  { args: ["--goal", " "], message: "缺少 --goal" },
  { args: ["--acceptance", " ; ; "], message: "至少写一条标准" },
  ...["NaN", "Infinity", "abc", "", "0", "5", "1.5"].map((priority) => ({
    args: ["--priority", priority],
    message: "--priority",
  })),
  { args: ["--status", ""], message: "缺少 --status" },
  ...[
    "secret",
    "Security",
    "安全",
    "security,",
    "security,none",
    "security;permission",
  ].map((tags) => ({
    args: ["--title", "Must not persist", "--risk-tags", tags],
    message: "--risk-tags 只接受",
  })),
  { args: ["--risk-tags=", "--title", "x"], message: "缺少 --risk-tags" },
  { args: ["--superseded-by"], message: "--superseded-by 需要一个值" },
  { args: ["--superseded-by", ""], message: "缺少 --superseded-by" },
  { args: ["--superseded-by", "W-2"], message: "合法的卡片编号" },
  { args: ["--title"], message: "--title 需要一个值" },
  { args: ["--title", "--status", "cancelled"], message: "--title 需要一个值" },
  {
    args: ["--titel", "typo", "--status", "cancelled"],
    message: "不认识的选项",
  },
  { args: ["C-2", "--status", "cancelled"], message: "一个合法的卡片编号" },
])("rejects invalid update args: $args", async ({ args, message }) => {
  const before = snapshot();
  expect(await run(["card", "update", "C-1", ...args])).toBe(2);
  expect(errors.join("\n")).toContain(message);
  expect(errors.join("\n")).toContain("用法：");
  expect(output).toEqual([]);
  expect(snapshot()).toEqual(before);
});

test.each([{ ids: [] }, { ids: ["W-1"] }, { ids: ["C-99"] }])(
  "rejects missing, malformed or absent card: $ids",
  async ({ ids }) => {
    const before = snapshot();
    expect(await run(["card", "update", ...ids, "--status", "cancelled"])).toBe(
      2,
    );
    expect(errors.join("\n")).toContain(
      ids[0] === "C-99" ? "卡片 C-99 在当前项目中不存在" : "合法的卡片编号",
    );
    expect(snapshot()).toEqual(before);
  },
);

test("explicit project overrides the environment and ambiguous projects fail", async () => {
  const otherProject = "p-other" as ProjectId;
  expect(await run(["project", "create", otherProject])).toBe(0);
  await createCard(otherProject);
  io.env.CARDIGAN_PROJECT = otherProject;
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--title",
      "Explicit",
      "--project",
      project,
    ]),
  ).toBe(0);
  expect(snapshot().cards[0]?.title).toBe("Explicit");
  expect(snapshot(otherProject).cards[0]?.title).toBe("Original title");
  expect(await run(["card", "update", "C-1", "--title", "Environment"])).toBe(
    0,
  );
  expect(snapshot(otherProject).cards[0]?.title).toBe("Environment");
  delete io.env.CARDIGAN_PROJECT;
  const before = snapshot();
  expect(await run(["card", "update", "C-1", "--status", "cancelled"])).toBe(2);
  expect(errors.join("\n")).toContain("有多个项目");
  expect(snapshot()).toEqual(before);
});

test.each([["--help"], ["card", "--help"], ["card", "update", "--help"]])(
  "help documents card update: %s",
  async (...args) => {
    expect(await run(args)).toBe(0);
    expect(output.join("\n")).toContain("card update");
    expect(output.join("\n")).toContain("--superseded-by <C-m>");
    expect(output.join("\n")).toContain("已完成卡片不能取消");
    expect(output.join("\n")).toContain("--risk-tags");
  },
);

test("card usage lists both create and update", async () => {
  expect(await run(["card"])).toBe(2);
  expect(errors.join("\n")).toContain("card create|update");
  expect(errors.join("\n")).toContain("--status backlog|todo|cancelled");
});

test.each(["done", "cancelled"] as const)(
  "marks %s cards as superseded and persists a distinct replacement",
  async (status) => {
    await createCard();
    await createCard();
    store.uow.run((tx) => {
      const card = tx.cards.list(project).find((c) => c.id === "C-1");
      if (!card) throw new Error("missing fixture card");
      tx.cards.put(project, {
        ...card,
        status,
        related_cards: ["C-3" as typeof card.id],
      });
    });
    const before = snapshot();
    expect(
      await run([
        "card",
        "update",
        "C-1",
        "--title",
        "Updated title",
        "--superseded-by",
        "C-2",
      ]),
    ).toBe(0);
    const after = snapshot();
    expect(after.cards.find((c) => c.id === "C-1")).toMatchObject({
      title: "Updated title",
      status,
      resolution: "superseded",
      superseded_by: "C-2",
      related_cards: ["C-3", "C-2"],
    });
    expect(after.work_items).toEqual(before.work_items);
    expect(
      after.events.filter((event) => event.card_id === "C-1").at(-1),
    ).toMatchObject({
      type: "card_superseded",
      payload: { card_id: "C-1", superseded_by: "C-2" },
    });
    expect(
      after.timeline.filter((entry) => entry.card_id === "C-1").at(-1)?.body,
    ).toBe("已被 C-2 取代");
    expect(output.join("\n")).toBe("已更新卡片 C-1：title、superseded-by");
    expect(await run(["card", "update", "C-1", "--superseded-by", "C-2"])).toBe(
      0,
    );
    expect(snapshot()).toEqual(after);
  },
);

test.each([
  { status: "done", target: "C-1", message: "不能被自身取代" },
  { status: "cancelled", target: "C-99", message: "当前项目中不存在" },
  { status: "todo", target: "C-2", message: "只有已完成或已取消" },
] as const)(
  "rejects invalid supersession ($status/$target) and rolls back combined updates",
  async ({ status, target, message }) => {
    await createCard();
    store.uow.run((tx) => {
      const card = tx.cards.list(project)[0];
      if (!card) throw new Error("missing fixture card");
      tx.cards.put(project, { ...card, status });
    });
    const before = snapshot();
    expect(
      await run([
        "card",
        "update",
        "C-1",
        "--title",
        "Must roll back",
        "--superseded-by",
        target,
      ]),
    ).toBe(2);
    expect(errors.join("\n")).toContain(message);
    expect(output).toEqual([]);
    expect(snapshot()).toEqual(before);
  },
);

test("cancels unfinished cards and marks their replacement in one transaction", async () => {
  await createCard();
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--status",
      "cancelled",
      "--superseded-by",
      "C-2",
    ]),
  ).toBe(0);
  expect(snapshot().cards.find((c) => c.id === "C-1")).toMatchObject({
    status: "cancelled",
    resolution: "superseded",
    superseded_by: "C-2",
  });
});

test.each([
  { card: "C-1", replacement: "C-99", missing: "C-99", changes: [] },
  {
    card: "C-1",
    replacement: "C-99",
    missing: "C-99",
    changes: ["--title", "Must roll back"],
  },
  { card: "C-99", replacement: "C-2", missing: "C-99", changes: [] },
])(
  "identifies the missing card when superseding $card with $replacement ($changes)",
  async ({ card, replacement, missing, changes }) => {
    await createCard();
    expect(await run(["card", "update", "C-1", "--status", "cancelled"])).toBe(
      0,
    );
    const before = snapshot();
    expect(
      await run([
        "card",
        "update",
        card,
        ...changes,
        "--superseded-by",
        replacement,
      ]),
    ).toBe(2);
    expect(errors.at(-1)).toBe(
      `无法更新卡片 ${card}：卡片 ${missing} 在当前项目中不存在（not_found）`,
    );
    expect(output).toEqual([]);
    expect(snapshot()).toEqual(before);
  },
);

test("does not resolve a replacement from another project and rolls back cancellation", async () => {
  const otherProject = "p-other" as ProjectId;
  expect(await run(["project", "create", otherProject])).toBe(0);
  await createCard(otherProject);
  await createCard(otherProject);
  const before = snapshot(),
    otherBefore = snapshot(otherProject);
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--project",
      project,
      "--status",
      "cancelled",
      "--superseded-by",
      "C-2",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("当前项目中不存在");
  expect(snapshot()).toEqual(before);
  expect(snapshot(otherProject)).toEqual(otherBefore);
});

test("C-238 CLI classification shares domain version validation and offers read-only comparison", async () => {
  const s = snapshot(),
    item = s.work_items.find((w) => w.kind === "produce");
  if (!item) throw new Error("Missing fixture producer");
  store.uow.run((tx) =>
    tx.deliveries.put(project, {
      id: "D-900",
      work_item_id: item.id,
      run_id: "R-900",
      kind: "code",
      summary: "Synthetic delivery",
      subject: { kind: "git_head", value: "a".repeat(40) },
      status: "submitted",
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
    } as import("@cardigan/domain").Delivery),
  );
  const input = {
    checked_versions: [
      { work_item_id: item.id, delivery_id: "D-900", subject: "a".repeat(40) },
    ],
    read_through_seq: Math.max(
      ...s.events.filter((e) => e.card_id === "C-1").map((e) => e.seq),
    ),
    risk_tags: [],
    risk_reviewed: true,
    is_ui: false,
    numeric_rules_approved: true,
    numeric_decision_ids: [],
    not_external_release: true,
    no_role_changes: true,
    timeline_reviewed: true,
  };
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--merge-classification",
      JSON.stringify(input),
    ]),
  ).toBe(0);
  expect(await run(["card", "merge-shadow", "C-1"])).toBe(0);
  expect(JSON.parse(output.at(-1) ?? "null")).toMatchObject({
    classification: { confirmed_by: "human", stale: false },
    comparisons: [],
  });
  const before = snapshot();
  expect(
    await run([
      "card",
      "update",
      "C-1",
      "--merge-classification",
      JSON.stringify({ ...input, checked_versions: [] }),
    ]),
  ).not.toBe(0);
  expect(snapshot()).toEqual(before);
});

test("C-370 CLI creates, replaces and clears dependencies with explicit waiting and early-start reasons", async () => {
  expect(
    await run([
      "card",
      "create",
      "--template",
      "general",
      "--title",
      "Dependent",
      "--goal",
      "Wait",
      "--depends-on-cards",
      "C-1",
      "--wait-for-dependencies",
      "on",
    ]),
  ).toBe(0);
  expect(snapshot().cards.find((c) => c.id === "C-2")).toMatchObject({
    status: "backlog",
    depends_on_cards: ["C-1"],
    wait_for_dependencies: true,
  });
  expect(
    await run(["card", "update", "C-1", "--depends-on-cards", "C-2"]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("依赖成环");
  expect(await run(["card", "update", "C-2", "--status", "todo"])).not.toBe(0);
  expect(
    await run([
      "card",
      "update",
      "C-2",
      "--status",
      "todo",
      "--early-start",
      "on",
      "--dependency-reason",
      "Parallel",
    ]),
  ).toBe(0);
  expect(
    snapshot().cards.find((c) => c.id === "C-2")?.early_start?.reason,
  ).toBe("Parallel");
  expect(
    await run([
      "card",
      "update",
      "C-2",
      "--depends-on-cards",
      "none",
      "--wait-for-dependencies",
      "off",
      "--early-start",
      "off",
      "--dependency-reason",
      "Complete normally",
    ]),
  ).toBe(0);
  expect(snapshot().cards.find((c) => c.id === "C-2")).toMatchObject({
    depends_on_cards: [],
    wait_for_dependencies: false,
  });
  expect(
    snapshot().cards.find((c) => c.id === "C-2")?.early_start,
  ).toBeUndefined();
});

test("CLI preserves explicit framework classification on create and update", async () => {
  expect(
    await run([
      "card",
      "create",
      "--template",
      "general",
      "--title",
      "Layout",
      "--goal",
      "Frame",
      "--is-ui-framework",
      "on",
    ]),
  ).toBe(0);
  expect(snapshot().cards.find((c) => c.id === "C-2")?.is_ui_framework).toBe(
    true,
  );
  expect(await run(["card", "update", "C-2", "--is-ui-framework", "off"])).toBe(
    0,
  );
  expect(snapshot().cards.find((c) => c.id === "C-2")?.is_ui_framework).toBe(
    false,
  );
});
