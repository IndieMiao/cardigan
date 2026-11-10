import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
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
    env: { CARDIGAN_DATA_DIR: dataDir },
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
  expect(await run(["init"])).toBe(0);
  expect(out.join("\n")).toContain(`数据库：${dataDir}`);
  expect(out.join("\n")).toContain("schema 版本：8");

  const store = Store.open({ dataDir });
  try {
    expect(store.schemaVersion()).toBe(8);
    expect(store.listProjects()).toEqual([]);
  } finally {
    store.close();
  }

  // Running it again is harmless and reports the same schema version.
  out = [];
  expect(await run(["init"])).toBe(0);
  expect(out.join("\n")).toContain("schema 版本：8");
});

test("cardigan project create records a project", async () => {
  expect(
    await run(["project", "create", "p-cli", "--name", "CLI project"]),
  ).toBe(0);
  expect(out.join("\n")).toContain("已创建项目 p-cli（CLI project）");

  const store = Store.open({ dataDir });
  try {
    expect(store.getProject("p-cli")).toMatchObject({ name: "CLI project" });
  } finally {
    store.close();
  }
});

test("creating the same project twice fails", async () => {
  expect(await run(["project", "create", "p-cli"])).toBe(0);
  expect(await run(["project", "create", "p-cli"])).toBe(2);
  expect(err.join("\n")).toContain(
    "无法创建项目 p-cli：项目已存在，不能重复创建（validation_failed）",
  );
});

test("cardigan role add writes allowed_tools and capabilities", async () => {
  await run(["project", "create", "p-cli"]);
  expect(
    await run([
      "role",
      "add",
      "p-cli",
      "coder",
      "--version",
      "3",
      "--allowed-tools",
      "whoami,get_card,get_updates",
      "--capabilities",
      "code, review",
    ]),
  ).toBe(0);
  expect(out.join("\n")).toContain("已写入角色 coder v3");

  const store = Store.open({ dataDir });
  try {
    const role = store.uow.read((tx) =>
      tx.roles.get("p-cli" as never, { role_id: "coder", role_version: 3 }),
    );
    expect(role).toEqual({
      role_id: "coder",
      role_version: 3,
      allowed_tools: ["whoami", "get_card", "get_updates"],
      capabilities: ["code", "review"],
    });
  } finally {
    store.close();
  }
});

test("role add rejects an unknown tool and lists the valid ones", async () => {
  await run(["project", "create", "p-cli"]);
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

test("invalid identifiers and flags are usage errors", async () => {
  expect(await run(["project", "create", "Bad Id"])).toBe(2);
  expect(err.join("\n")).toContain("不合法");

  expect(await run(["project", "create", "p-cli", "--nope", "1"])).toBe(2);
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
