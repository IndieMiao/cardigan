import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMigrationsDir, listMigrations, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { roleConfig } from "../../../test-support/launch-fixture.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-cli-admin-"));
  out = [];
  err = [];
  io = {
    env: {
      CARDIGAN_CONFIG_DIR: roleConfig(dataDir, "codex-agent", "test-agent"),
      CARDIGAN_DATA_DIR: dataDir,
    },
    cwd: dataDir,
    platform: "linux",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("admin commands must not spawn");
    },
    captureCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function run(argv: string[]): Promise<number> {
  return main(argv, io);
}

test("cardigan init creates the database and runs migrations", async () => {
  const latestVersion = Math.max(
    ...listMigrations(defaultMigrationsDir).map(
      (migration) => migration.version,
    ),
  );
  expect(await run(["init"])).toBe(0);
  expect(out.join("\n")).toContain(`数据库：${dataDir}`);
  expect(out.join("\n")).toContain(`schema 版本：${latestVersion}`);

  const store = Store.open({ dataDir });
  try {
    expect(store.schemaVersion()).toBe(latestVersion);
    expect(store.listProjects()).toEqual([]);
  } finally {
    store.close();
  }

  // Running it again is harmless and reports the same schema version.
  out = [];
  expect(await run(["init"])).toBe(0);
  expect(out.join("\n")).toContain(`schema 版本：${latestVersion}`);
});

test("cardigan project create records a project", async () => {
  expect(
    await run([
      "project",
      "create",
      "p-cli",
      "--name",
      "CLI project",
      "--code",
      "CLI",
    ]),
  ).toBe(0);
  expect(out.join("\n")).toContain("已创建项目 p-cli（CLI project），代号 CLI");

  const store = Store.open({ dataDir });
  try {
    expect(store.getProject("p-cli")).toMatchObject({
      name: "CLI project",
      code: "CLI",
    });
  } finally {
    store.close();
  }
});

test("project create requires a code and suggests a free one", async () => {
  expect(await run(["project", "create", "sensen-godot"])).toBe(2);
  expect(err.join("\n")).toContain("建议：--code SEN");
  expect(
    await run(["project", "create", "sensen-godot", "--code", "SEN"]),
  ).toBe(0);
  // The three-character stem is taken: the suggestion moves to four.
  expect(await run(["project", "create", "sensei"])).toBe(2);
  expect(err.join("\n")).toContain("建议：--code SENS");
  for (const code of ["SEN", "sen", "S1", "1SEN", "SENSE"])
    expect(
      await run(["project", "create", "sensei", "--code", code]),
      code,
    ).toBe(2);
  expect(err.join("\n")).toContain("已被其它项目使用");
  expect(err.join("\n")).toContain("3–4 位大写字母或数字");
});

test("project code shows the code and refuses to change it", async () => {
  expect(await run(["project", "create", "p-cli", "--code", "CLI"])).toBe(0);
  out = [];
  expect(await run(["project", "code", "--project", "p-cli"])).toBe(0);
  expect(out.join("\n")).toContain("项目 p-cli 的代号：CLI");
  expect(
    await run(["project", "code", "--set", "CLX", "--project", "p-cli"]),
  ).toBe(2);
  expect(err.join("\n")).toContain("登记后不可修改");

  // A project without a code (pre-migration rows) can register one once.
  const store = Store.open({ dataDir });
  try {
    store.database
      .prepare(
        "INSERT INTO projects (id, name, created_at) VALUES ('legacy', 'legacy', '2026-01-01T00:00:00.000Z')",
      )
      .run();
  } finally {
    store.close();
  }
  out = [];
  expect(await run(["project", "code", "--project", "legacy"])).toBe(0);
  expect(out.join("\n")).toContain(
    "还没有登记代号；建议：cardigan project code --set LEG --project legacy",
  );
  expect(
    await run(["project", "code", "--set", "LEG", "--project", "legacy"]),
  ).toBe(0);
  expect(out.join("\n")).toContain("项目 legacy 已登记代号 LEG");
});

test("creating the same project twice fails", async () => {
  expect(await run(["project", "create", "p-cli", "--code", "CLI"])).toBe(0);
  expect(await run(["project", "create", "p-cli", "--code", "CLI"])).toBe(2);
  expect(err.join("\n")).toContain(
    "无法创建项目 p-cli：项目已存在，不能重复创建（validation_failed）",
  );
});

test("cardigan role add writes allowed_tools and capabilities", async () => {
  await run(["project", "create", "p-cli", "--code", "CLI"]);
  expect(
    await run([
      "role",
      "add",
      "p-cli",
      "coder",
      "--version",
      "1",
      "--allowed-tools",
      "whoami,get_card,get_updates",
      "--capabilities",
      "code, review",
    ]),
  ).toBe(0);
  expect(out.join("\n")).toContain("已写入角色 coder v1");

  const store = Store.open({ dataDir });
  try {
    const role = store.uow.read((tx) =>
      tx.roles.get("p-cli" as never, { role_id: "coder", role_version: 1 }),
    );
    expect(role).toMatchObject({
      role_id: "coder",
      role_version: 1,
      allowed_tools: ["whoami", "get_card", "get_updates"],
      capabilities: ["code", "review"],
    });
  } finally {
    store.close();
  }
});

test("role add rejects an unknown tool and lists the valid ones", async () => {
  await run(["project", "create", "p-cli", "--code", "CLI"]);
  expect(
    await run([
      "role",
      "add",
      "p-cli",
      "coder",
      "--allowed-tools",
      "whoami,launch_rocket",
    ]),
  ).toBe(2);
  expect(err.join("\n")).toContain("launch_rocket");
  expect(err.join("\n")).toContain("get_card");
});

test("role add requires the project to exist", async () => {
  expect(await run(["role", "add", "p-missing", "coder"])).toBe(2);
  expect(err.join("\n")).toContain("项目 p-missing 不存在");
});

test.each([
  {
    scenario: "duplicate",
    command: "add",
    expected:
      "无法创建角色 tester：角色已存在，请用 cardigan role update 添加新版本（validation_failed）",
  },
  {
    scenario: "missing",
    command: "update",
    expected:
      "无法更新角色 tester：角色不存在，请先用 cardigan role add 创建（not_found）",
  },
  {
    scenario: "version",
    command: "add",
    expected:
      "无法创建角色 tester：--version 必须是下一个版本，不能覆盖或跳过版本（validation_failed）",
  },
])(
  "role rules report complete Chinese errors without changing history: $scenario",
  async ({ scenario, command, expected }) => {
    await run(["project", "create", "p-cli", "--code", "CLI"]);
    const file = join(dataDir, "tester.yaml");
    writeFileSync(
      file,
      `role_id: tester
display_name: Tester
kind: work
core_prompt: Test the delivery.
harness: codex
launch_profile_ref: test-agent
worktree: none
`,
    );
    if (scenario !== "missing")
      expect(await run(["role", "add", "--file", file])).toBe(0);
    const store = Store.open({ dataDir });
    try {
      const before = store.uow.read((tx) => tx.roles.list("p-cli"));
      out = [];
      err = [];
      expect(
        await run(
          scenario === "version"
            ? ["role", "add", "p-cli", "tester", "--version", "4"]
            : ["role", command, "--file", file],
        ),
      ).toBe(2);
      expect(err[0]).toBe(`数据目录：${dataDir}`);
      expect(err[1]?.split("\n")[0]).toBe(expected);
      expect(err).toHaveLength(2);
      expect(out).toEqual([]);
      expect(store.uow.read((tx) => tx.roles.list("p-cli"))).toEqual(before);
    } finally {
      store.close();
    }
  },
);

test("invalid identifiers and flags are usage errors", async () => {
  expect(await run(["project", "create", "Bad Id"])).toBe(2);
  expect(err.join("\n")).toContain("不合法");

  expect(
    await run(["project", "create", "p-cli", "--code", "CLI", "--nope", "1"]),
  ).toBe(2);
  expect(err.join("\n")).toContain("不认识的选项");

  expect(await run(["role", "add", "p-cli", "coder", "--version", "0"])).toBe(
    2,
  );
  expect(err.join("\n")).toContain("--version");

  expect(await run(["init", "extra"])).toBe(2);
});

test("--data-dir overrides CARDIGAN_DATA_DIR", async () => {
  const other = mkdtempSync(join(tmpdir(), "cardigan-cli-admin-other-"));
  try {
    expect(await run(["init", "--data-dir", other])).toBe(0);
    expect(out.join("\n")).toContain(other);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
