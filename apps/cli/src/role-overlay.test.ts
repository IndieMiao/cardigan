import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRoleOverlay, type Role } from "@cardigan/domain";
import { deploymentRolePolicyHash, knownDefaults } from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { roleConfig } from "../../../test-support/launch-fixture.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const PROJECT = "p-overlay";
const TIME_RULE = "时间点约束：只认交付时刻的基线和证据。";
let root: string;
let dataDir: string;
let output: string[];
let io: CliIo;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cardigan-role-overlay-"));
  dataDir = join(root, "data");
  io = {
    env: {
      CARDIGAN_CONFIG_DIR: roleConfig(root, "codex-agent"),
      CARDIGAN_DATA_DIR: dataDir,
    },
    cwd: root,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("role commands must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  await run(["init"]);
  await run([
    "project",
    "create",
    PROJECT,
    "--code",
    `T${PROJECT.replace(/[^a-z0-9]/gu, "")
      .slice(0, 3)
      .toUpperCase()}`,
  ]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(argv: string[]): Promise<number> {
  output = [];
  return main(argv, io);
}
const printed = () => output.join("\n");
function store<T>(read: (store: Store) => T): T {
  const s = Store.open({ dataDir });
  try {
    return read(s);
  } finally {
    s.close();
  }
}
const latest = (id: string) =>
  store((s) => s.uow.read((tx) => getRoleVersion(tx, PROJECT, id))) as Role;
function write(role: Role) {
  store((s) =>
    s.uow.run((tx) => writeRole(tx, PROJECT, role, { mode: "update" })),
  );
}

test("C-613 role overlay migrates a customised role and prints the before/after comparison", async () => {
  expect(
    await run([
      "role",
      "copy",
      "reviewer",
      "reviewer",
      "--from-default",
      "--harness",
      "codex",
      "--launch-profile",
      "codex-agent",
    ]),
  ).toBe(0);
  const v1 = latest("reviewer");
  write({
    ...v1,
    version: 2,
    instructions: `${v1.instructions}\n\n${TIME_RULE}`,
  });
  const before = latest("reviewer");

  expect(await run(["role", "overlay", "reviewer", "--dry-run"])).toBe(0);
  expect(printed()).toContain("追加说明：1 段");
  expect(printed()).toContain(`    | ${TIME_RULE}`);
  expect(printed()).toContain(
    `迁移前策略指纹：${deploymentRolePolicyHash(before)}`,
  );
  expect(printed()).toContain(
    `迁移后策略指纹：${deploymentRolePolicyHash(before)}`,
  );
  expect(latest("reviewer").version).toBe(2);

  expect(await run(["role", "overlay", "reviewer"])).toBe(0);
  expect(printed()).toContain("已登记 reviewer v3");
  const v3 = latest("reviewer");
  expect(v3.instructions).toBe(before.instructions);
  expect(v3.default_overlay).toMatchObject({
    base_role_id: "reviewer",
    append_instructions: TIME_RULE,
    extra_tools: [],
    removed_tools: [],
  });
  expect(await run(["role", "overlay", "reviewer"])).toBe(0);
  expect(printed()).toContain("没有追加新版本");

  // Explicit rules replace only the named part.
  expect(
    await run([
      "role",
      "overlay",
      "reviewer",
      "--remove-tools",
      "project_snapshot",
    ]),
  ).toBe(0);
  const v4 = latest("reviewer");
  expect(v4.version).toBe(4);
  expect(v4.allowed_tools).not.toContain("project_snapshot");
  expect(v4.default_overlay).toMatchObject({
    append_instructions: TIME_RULE,
    removed_tools: ["project_snapshot"],
  });
});

test("C-613 role upgrade --from-default keeps the project rules instead of overwriting them", async () => {
  const pack = defaultRoleDefinition("reviewer", {
    harness: "codex",
    launch_profile_ref: "codex-agent",
  });
  const older = {
    ...pack,
    core_prompt: "",
    version: 1,
    instructions: `Older default\n\n${TIME_RULE}`,
  } as Role;
  const rules = {
    base_role_id: "reviewer",
    append_instructions: TIME_RULE,
    extra_tools: [],
    removed_tools: [],
  };
  store((s) =>
    s.uow.run((tx) =>
      writeRole(
        tx,
        PROJECT,
        {
          ...older,
          default_overlay: {
            ...rules,
            base_hash: "older",
            composed_hash: deploymentRolePolicyHash(older),
          },
        },
        { mode: "add" },
      ),
    ),
  );
  expect(
    await run(["role", "upgrade", "reviewer", "--from-default", "--dry-run"]),
  ).toBe(0);
  expect(printed()).toContain("按“当前默认包 + 附加规则”升级");
  expect(latest("reviewer").version).toBe(1);
  // A dry run records nothing.
  const recorded = () =>
    store((s) =>
      s.uow.read((tx) => knownDefaults(tx, PROJECT).get("reviewer") ?? []),
    );
  expect(recorded()).toEqual([]);
  expect(await run(["role", "upgrade", "reviewer", "--from-default"])).toBe(0);
  const next = latest("reviewer");
  expect(next.version).toBe(2);
  expect(next.instructions).toBe(`${pack.instructions}\n\n${TIME_RULE}`);
  // The default this upgrade took joins the trusted record (C-603/C-613).
  expect(recorded()).toEqual([
    expect.objectContaining({ policy_hash: deploymentRolePolicyHash(pack) }),
  ]);
  expect(next.default_overlay).toMatchObject({
    ...rules,
    base_hash: deploymentRolePolicyHash(pack),
    composed_hash: deploymentRolePolicyHash(next),
  });
});

test("C-613 a role outside the default pack needs an explicit base", async () => {
  expect(
    await run([
      "role",
      "copy",
      "coder",
      "doc_writer",
      "--from-default",
      "--harness",
      "codex",
      "--launch-profile",
      "codex-agent",
    ]),
  ).toBe(0);
  expect(await run(["role", "overlay", "doc_writer", "--dry-run"])).toBe(2);
  expect(printed()).toContain("--base");
  expect(
    await run([
      "role",
      "overlay",
      "doc_writer",
      "--base",
      "coder",
      "--dry-run",
    ]),
  ).toBe(0);
  expect(printed()).toContain("默认角色 coder + 项目附加规则");
  expect(await run(["role", "overlay", "doc_writer", "--base", "nope"])).toBe(
    2,
  );
  writeFileSync(join(root, "extra.md"), "发布前核对渠道。\n");
  expect(
    await run([
      "role",
      "overlay",
      "doc_writer",
      "--base",
      "coder",
      "--append-file",
      "extra.md",
    ]),
  ).toBe(0);
  expect(latest("doc_writer").instructions).toMatch(/\n\n发布前核对渠道。$/u);
  // A later plain upgrade now works for the non-default id.
  expect(await run(["role", "upgrade", "doc_writer", "--from-default"])).toBe(
    0,
  );
  expect(printed()).toContain("已是默认包内容");
});

test("C-613 V-3026: partial options keep unspecified rules, and a rerun keeps an explicit removal", async () => {
  const pack = defaultRoleDefinition("reviewer", {
    harness: "codex",
    launch_profile_ref: "codex-agent",
  });
  store((s) =>
    s.uow.run((tx) =>
      writeRole(
        tx,
        PROJECT,
        {
          ...pack,
          core_prompt: "",
          version: 1,
          instructions: `${pack.instructions}\n\n${TIME_RULE}`,
          allowed_tools: [...pack.allowed_tools, "list_needs_you"],
        } as Role,
        { mode: "add" },
      ),
    ),
  );
  expect(
    await run([
      "role",
      "overlay",
      "reviewer",
      "--remove-tools",
      "project_snapshot",
    ]),
  ).toBe(0);
  const v2 = latest("reviewer");
  expect(v2.instructions).toBe(`${pack.instructions}\n\n${TIME_RULE}`);
  expect(v2.allowed_tools).toContain("list_needs_you");
  expect(v2.allowed_tools).not.toContain("project_snapshot");
  expect(v2.default_overlay).toMatchObject({
    append_instructions: TIME_RULE,
    extra_tools: ["list_needs_you"],
    removed_tools: ["project_snapshot"],
  });
  expect(await run(["role", "overlay", "reviewer"])).toBe(0);
  expect(printed()).toContain("没有追加新版本");
  expect(latest("reviewer").allowed_tools).not.toContain("project_snapshot");
  // A tool the current version lacks stays out unless explicitly added back.
  expect(
    await run([
      "role",
      "overlay",
      "reviewer",
      "--add-tools",
      "project_snapshot",
    ]),
  ).toBe(0);
  expect(latest("reviewer").allowed_tools).toContain("project_snapshot");
  expect(latest("reviewer").default_overlay?.removed_tools).toEqual([]);
});

test("C-613 V-3026: a role of its own keeps its text and follows only the base's tools", async () => {
  const pack = defaultRoleDefinition("tester", {
    harness: "codex",
    launch_profile_ref: "codex-agent",
  });
  const own = "发布员：只负责核对渠道和版本号。";
  store((s) =>
    s.uow.run((tx) =>
      writeRole(
        tx,
        PROJECT,
        {
          ...pack,
          role_id: "release_checker",
          display_name: "发布核对",
          core_prompt: "",
          version: 1,
          instructions: own,
          allowed_tools: pack.allowed_tools.filter(
            (t) => t !== "project_snapshot",
          ),
        } as Role,
        { mode: "add" },
      ),
    ),
  );
  expect(
    await run([
      "role",
      "overlay",
      "release_checker",
      "--base",
      "tester",
      "--keep-instructions",
      "--dry-run",
    ]),
  ).toBe(0);
  expect(printed()).toContain("保留本角色自己的说明");
  expect(printed()).toContain("登记为显式移除");
  expect(
    await run([
      "role",
      "overlay",
      "release_checker",
      "--base",
      "tester",
      "--keep-instructions",
    ]),
  ).toBe(0);
  const next = latest("release_checker");
  expect(next.instructions).toBe(own);
  expect(next.allowed_tools).not.toContain("project_snapshot");
  expect(next.default_overlay).toMatchObject({
    base_role_id: "tester",
    instructions_mode: "replace",
    removed_tools: ["project_snapshot"],
  });
});

test("C-613 V-3028: release_ops follows a default of the same kind and never gains PM-only tools", async () => {
  const coder = defaultRoleDefinition("coder", {
    harness: "codex",
    launch_profile_ref: "codex-agent",
  });
  const own = "发布员：只负责核对渠道、版本号并发布制品。";
  store((s) =>
    s.uow.run((tx) =>
      writeRole(
        tx,
        PROJECT,
        {
          ...coder,
          role_id: "release_ops",
          display_name: "发布员",
          core_prompt: "",
          version: 1,
          instructions: own,
          allowed_tools: ["whoami", "publish_artifact"],
        } as Role,
        { mode: "add" },
      ),
    ),
  );
  // A base of another kind would rewrite kind, worktree and capabilities.
  expect(
    await run([
      "role",
      "overlay",
      "release_ops",
      "--base",
      "pm",
      "--keep-instructions",
      "--dry-run",
    ]),
  ).toBe(2);
  expect(printed()).toContain("kind");
  // send_owner_message stays a standing-PM tool.
  expect(
    await run([
      "role",
      "overlay",
      "release_ops",
      "--base",
      "coder",
      "--keep-instructions",
      "--add-tools",
      "send_owner_message",
    ]),
  ).toBe(2);
  expect(
    await run([
      "role",
      "overlay",
      "release_ops",
      "--base",
      "coder",
      "--keep-instructions",
    ]),
  ).toBe(0);
  const next = latest("release_ops");
  expect(next.version).toBe(2);
  expect(next.instructions).toBe(own);
  expect([...next.allowed_tools].sort()).toEqual([
    "publish_artifact",
    "whoami",
  ]);
  expect(next.default_overlay).toMatchObject({
    base_role_id: "coder",
    instructions_mode: "replace",
    extra_tools: ["publish_artifact"],
  });
});

test("C-613 V-3028: an explicit removal outside today's pack is kept for later packs", async () => {
  const pack = defaultRoleDefinition("reviewer", {
    harness: "codex",
    launch_profile_ref: "codex-agent",
  });
  store((s) =>
    s.uow.run((tx) =>
      writeRole(
        tx,
        PROJECT,
        {
          ...pack,
          core_prompt: "",
          version: 1,
          allowed_tools: [...pack.allowed_tools, "list_needs_you"],
        } as Role,
        { mode: "add" },
      ),
    ),
  );
  expect(
    await run([
      "role",
      "overlay",
      "reviewer",
      "--remove-tools",
      "list_needs_you",
    ]),
  ).toBe(0);
  const overlay = latest("reviewer").default_overlay;
  expect(overlay?.removed_tools).toEqual(["list_needs_you"]);
  expect(
    composeRoleOverlay(
      { ...pack, allowed_tools: [...pack.allowed_tools, "list_needs_you"] },
      overlay as NonNullable<typeof overlay>,
    ).allowed_tools,
  ).not.toContain("list_needs_you");
});

test("C-613 V-3028: a role without review tools gets neither submit nor withdraw", async () => {
  const pack = defaultRoleDefinition("reviewer", {
    harness: "codex",
    launch_profile_ref: "codex-agent",
  });
  store((s) =>
    s.uow.run((tx) =>
      writeRole(
        tx,
        PROJECT,
        {
          ...pack,
          core_prompt: "",
          version: 1,
          allowed_tools: pack.allowed_tools.filter(
            (t) => t !== "submit_review" && t !== "withdraw_review",
          ),
        } as Role,
        { mode: "add" },
      ),
    ),
  );
  expect(await run(["role", "overlay", "reviewer"])).toBe(0);
  const next = latest("reviewer");
  expect(next.allowed_tools).not.toContain("submit_review");
  expect(next.allowed_tools).not.toContain("withdraw_review");
  expect([...(next.default_overlay?.removed_tools ?? [])].sort()).toEqual([
    "submit_review",
    "withdraw_review",
  ]);
});
