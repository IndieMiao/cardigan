import type { GitCentralPort, GitFileDiff } from "@cardigan/domain";
import { expect, test } from "vitest";
import { collectRoleRuleInventory } from "./role-rule-inventory.js";

const base = "a".repeat(40),
  sha = "b".repeat(40),
  tree = "c".repeat(40);
const file = (path: string, before: string, after: string): GitFileDiff => ({
  path,
  old_mode: "100644",
  new_mode: "100644",
  old_oid: base,
  new_oid: sha,
  status: "M",
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`,
  before: `${before}\n`,
  after: `${after}\n`,
});
const collect = (files: GitFileDiff[]) =>
  collectRoleRuleInventory(
    {
      treeOfCommit: async () => tree,
      fileDiffs: async () => files,
    } as unknown as GitCentralPort,
    "repo",
    base,
    sha,
  );

test("host inventory binds complete Git facts and never accepts an author's body classification", async () => {
  const files = [
    file("AGENTS.md", "日志使用中文。", "日志和说明使用中文。"),
    file("hidden-new-prompt.txt", "old", "new"),
  ];
  const inventory = await collect(files);
  expect(inventory).toMatchObject({
    version: 1,
    complete: true,
    base_sha: base,
    sha,
    tree_sha: tree,
  });
  expect(inventory.changes.map((c) => c.category)).toEqual(["body", "unknown"]);
  expect(inventory.changes[0]?.edits).toEqual([
    {
      id: "AGENTS.md:@@ -1 +1 @@",
      before: "日志使用中文。\n",
      after: "日志和说明使用中文。\n",
    },
  ]);
  const missing = await collectRoleRuleInventory(
    { treeOfCommit: async () => tree } as unknown as GitCentralPort,
    "repo",
    base,
    sha,
  );
  expect(missing.complete).toBe(false);
});

test.each([
  "allowed_tools",
  "capabilities",
  "员工隔离",
  "审核",
  "PM 自身代确认权限",
  "授权",
])("%s cannot use the body exception", async (text) => {
  expect(
    (await collect([file("AGENTS.md", "旧规则", text)])).changes[0]?.category,
  ).toBe("forbidden");
});

test("mode, move, binary, unknown format and encoded permissions fail closed", async () => {
  const plain = file("AGENTS.md", "旧规则", "新规则");
  const source = file(
    "packages/roles/src/role-pack.ts",
    '  "旧说明",',
    '  "\\u6743\\u9650",',
  );
  const inventory = await collect([
    { ...plain, new_mode: "100755" },
    { ...plain, status: "A" },
    { ...plain, patch: "Binary files differ" },
    file("roles/custom.yaml", "old", "new"),
    source,
    file("packages/roles/src/role-pack.ts", '  "old",', '  "new",'),
  ]);
  expect(inventory.changes.map((c) => c.category)).toEqual([
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "forbidden",
    "unknown",
  ]);
});

test("only unchanged source structure and whole prompt string entries establish a body edit", async () => {
  const f = file(
    "packages/roles/src/role-pack.ts",
    '  "日志使用中文。",',
    '  "日志和说明使用中文。",',
  );
  const prefix = "const ROLE_BODIES = {\n coder: [\n",
    suffix = "]};\nexport const DEFAULT_ROLE_KINDS = {};\n";
  const source = {
    ...f,
    before: prefix + f.before + suffix,
    after: prefix + f.after + suffix,
  };
  expect((await collect([source])).changes[0]?.category).toBe("body");
  expect(
    (
      await collect([
        { ...source, after: `${source.after}const allowed_tools = [];` },
      ])
    ).changes[0]?.category,
  ).toBe("unknown");
});
