import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string;
let store: Store;
let output: string[];
let errors: string[];
let io: CliIo;
const add = ["add", "--name", "诸葛亮", "--title", "产品经理", "--role", "pm"];
async function run(args: string[]) {
  output = [];
  errors = [];
  return main(["employee", ...args], io);
}
const snapshot = () =>
  store.uow.read((tx) => ({
    employees: tx.employees.list(),
    events: tx.global_events.listAfter(0),
  }));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-employees-"));
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_CONFIG_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("must not launch agents");
    },
    captureCommand: async () => {
      throw new Error("must not launch agents");
    },
  };
  store = Store.open({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test.each(["update", "activate", "deactivate"])(
  "%s explains the missing employee ID with a command example",
  async (command) => {
    const before = snapshot();
    expect(await run([command])).toBe(2);
    expect(errors.join("\n")).toContain(
      `缺少员工编号：cardigan employee ${command} E-1${command === "update" ? " --name 诸葛亮" : ""}（用 cardigan employee list 查看编号）`,
    );
    expect(await run(["update", "--name", "诸葛亮"])).toBe(2);
    expect(errors.join("\n")).toContain("缺少员工编号");
    expect(snapshot()).toEqual(before);
  },
);

test("human CLI creates, lists, updates, deactivates and activates global employees without a project", async () => {
  expect(
    await run([...add, "--bio", "管理项目", "--avatar", "library:zhuge-liang"]),
  ).toBe(0);
  expect(output.join("\n")).toContain("已创建员工 E-1：诸葛亮");
  expect(errors.join("\n")).toContain(`数据目录：${dataDir}`);
  expect(await run(["list"])).toBe(0);
  expect(output.join("\n")).toContain("E-1  诸葛亮  产品经理  角色：pm  在职");
  expect(
    await run([
      "update",
      "E-1",
      "--name=孔明",
      "--title",
      "经理",
      "--bio",
      "新简介",
      "--avatar",
      "",
    ]),
  ).toBe(0);
  expect(output.join("\n")).toContain("已更新员工 E-1：孔明");
  expect(snapshot().employees[0]).toMatchObject({
    name: "孔明",
    title: "经理",
    bio: "新简介",
    avatar: null,
    role_id: "pm",
  });
  expect(await run(["deactivate", "E-1"])).toBe(0);
  expect(output.join("\n")).toContain("已停用员工 E-1");
  expect(await run(["list"])).toBe(0);
  expect(output.join("\n")).toBe("没有符合条件的员工");
  expect(await run(["list", "--all"])).toBe(0);
  expect(output.join("\n")).toContain("已停用");
  expect(await run(["activate", "E-1"])).toBe(0);
  expect(output.join("\n")).toContain("已恢复员工 E-1");
  expect(snapshot().events.map((e) => e.type)).toEqual([
    "member_created",
    "employee_created",
    "employee_updated",
    "employee_deactivated",
    "employee_activated",
  ]);
  expect(
    snapshot()
      .events.filter((e) => e.type.startsWith("employee_"))
      .every((e) => e.actor.kind === "human"),
  ).toBe(true);
});

test("avatar list exposes all bundled names and employee add/update persist library references", async () => {
  output = [];
  errors = [];
  expect(await main(["avatar", "list"], io)).toBe(0);
  expect(output.join("\n").split("\n")).toHaveLength(60);
  expect(output.join("\n")).toContain("guan-yu  关羽  三国演义");
  expect(await run([...add, "--avatar", "library:guan-yu"])).toBe(0);
  expect(snapshot().employees[0]?.avatar).toBe("library:guan-yu");
  expect(await run(["update", "E-1", "--avatar", "library:sun-wukong"])).toBe(
    0,
  );
  expect(snapshot().employees[0]?.avatar).toBe("library:sun-wukong");
  const before = snapshot();
  for (const reference of [
    "library:missing",
    "library:../guan-yu",
    "https://example.com/a.png",
    `upload:${"a".repeat(64)}`,
  ]) {
    expect(await run(["update", "E-1", "--avatar", reference])).not.toBe(0);
    expect(errors.join("\n")).toMatch(/头像素材库中没有人物|--avatar 请使用/);
    expect(snapshot()).toEqual(before);
    expect(await run([...add, "--avatar", reference])).not.toBe(0);
    expect(snapshot()).toEqual(before);
  }
});

test("CLI cannot reuse a library character reserved by an inactive employee", async () => {
  expect(await run([...add, "--avatar", "library:guan-yu"])).toBe(0);
  expect(await run(["deactivate", "E-1"])).toBe(0);
  const before = snapshot();
  expect(
    await run([
      "add",
      "--name",
      "另一位",
      "--title",
      "开发",
      "--role",
      "coder",
      "--avatar",
      "library:guan-yu",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("人物已被员工");
  expect(snapshot()).toEqual(before);
});

test("avatar-file uses content and caller cwd on add/update, deduplicates, and may be cleared", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = createHash("sha256").update(png).digest("hex");
  writeFileSync(join(dataDir, "actually-png.txt"), png);
  expect(await run([...add, "--avatar-file", "actually-png.txt"])).toBe(0);
  expect(snapshot().employees[0]?.avatar).toBe(`upload:${digest}`);
  expect(readFileSync(join(dataDir, "avatars", `${digest}.png`))).toEqual(png);
  expect(
    await run(["update", "E-1", "--avatar-file", "actually-png.txt"]),
  ).toBe(0);
  expect(readdirSync(join(dataDir, "avatars"))).toEqual([`${digest}.png`]);
  expect(await run(["update", "E-1", "--avatar", "library:guan-yu"])).toBe(0);
  expect(
    await run(["update", "E-1", "--avatar-file", "actually-png.txt"]),
  ).toBe(0);
  expect(snapshot().employees[0]?.avatar).toBe(`upload:${digest}`);
  expect(await run(["update", "E-1", "--avatar", ""])).toBe(0);
  expect(snapshot().employees[0]?.avatar).toBeNull();
});

test("invalid uploads and conflicting flags leave employee state unchanged", async () => {
  expect(await run(add)).toBe(0);
  const before = snapshot();
  const fixtures = [
    ["fake.png", Buffer.from("<svg></svg>"), "只支持 PNG、WebP 或 JPEG"],
    ["large.webp", Buffer.alloc(2 * 1024 * 1024 + 1), "2 MiB"],
  ] as const;
  for (const [path, bytes, message] of fixtures) {
    writeFileSync(join(dataDir, path), bytes);
    expect(await run(["update", "E-1", "--avatar-file", path])).not.toBe(0);
    expect(errors.join("\n")).toContain(message);
    expect(snapshot()).toEqual(before);
  }
  expect(await run(["update", "E-1", "--avatar-file", "missing"])).not.toBe(0);
  expect(errors.join("\n")).toContain("无法上传头像");
  expect(
    await run(["update", "E-1", "--avatar", "", "--avatar-file", "fake.png"]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("不能同时使用");
  expect(snapshot()).toEqual(before);
});

test("global list supports role filters and ignores project selection", async () => {
  expect(await run(add)).toBe(0);
  store.createProject({ id: "one" });
  store.createProject({ id: "two" });
  io.env.CARDIGAN_PROJECT = "two";
  expect(
    await run(["add", "--name", "关羽", "--title", "开发", "--role", "coder"]),
  ).toBe(0);
  expect(output.join("\n")).toContain("E-2");
  expect(await run(["list", "--role", "coder"])).toBe(0);
  expect(output.join("\n")).toContain("关羽");
  expect(output.join("\n")).not.toContain("诸葛亮");
  const before = snapshot();
  expect(await run(add)).toBe(2);
  expect(errors.at(-1)).toBe(
    "无法创建员工 诸葛亮：在职员工已使用名字：诸葛亮（validation_failed）",
  );
  expect(snapshot()).toEqual(before);
});

test("launch-profile is checked on add and update, clearing is explicit and role stays unchanged", async () => {
  expect(await run([...add, "--launch-profile", "fixture"])).not.toBe(0);
  expect(errors.join("\n")).toContain("找不到启动配置");
  expect(snapshot().employees).toEqual([]);
  writeFileSync(
    join(dataDir, "launch.yaml"),
    `providers:
  example:
    harness: codex
    env: {}
    secret_env: {}
profiles:
  fixture:
    harness: codex
    provider: example
    model: fixture-model
`,
  );
  expect(await run([...add, "--launch-profile", "missing"])).not.toBe(0);
  expect(errors.join("\n")).toContain("不存在于 launch.yaml");
  expect(snapshot().employees).toEqual([]);
  expect(await run([...add, "--launch-profile", "fixture"])).toBe(0);
  expect(snapshot().employees[0]).toMatchObject({
    id: "E-1",
    launch_profile_ref: "fixture",
    role_id: "pm",
  });
  const before = snapshot();
  expect(
    await run([
      "update",
      "E-1",
      "--name",
      "不应保存",
      "--launch-profile",
      "missing",
    ]),
  ).not.toBe(0);
  expect(errors.join("\n")).toContain("不存在于 launch.yaml");
  expect(snapshot()).toEqual(before);
  expect(await run(["update", "E-1", "--launch-profile", "fixture"])).toBe(0);
  rmSync(join(dataDir, "launch.yaml"));
  expect(
    await run(["update", "E-1", "--launch-profile", "", "--bio", ""]),
  ).toBe(0);
  expect(snapshot().employees[0]).toMatchObject({
    launch_profile_ref: null,
    bio: "",
    role_id: "pm",
  });
});

test("duplicate rename and reactivation fail atomically with Chinese errors", async () => {
  expect(await run(add)).toBe(0);
  expect(await run(["deactivate", "E-1"])).toBe(0);
  expect(await run(add)).toBe(0);
  const before = snapshot();
  expect(await run(["activate", "E-1"])).not.toBe(0);
  expect(errors.join("\n")).toContain("在职员工已使用名字");
  expect(snapshot()).toEqual(before);
  expect(await run(["update", "E-1", "--name", "孔明"])).toBe(0);
  expect(await run(["activate", "E-1"])).toBe(0);
  expect(await run(["update", "E-2", "--name", "　孔明 "])).not.toBe(0);
  expect(errors.join("\n")).toContain("在职员工已使用名字");
});

test.each([
  [["add"], "新增员工需要"],
  [[...add, "--bio", "bad\nline"], "控制字符"],
  [[...add, "--name", "另一个"], "不能重复"],
  [["list", "--all=true"], "--all 不接受值"],
  [["list", "--role"], "需要一个值"],
  [["list", "extra"], "位置参数"],
  [["update", "E-1"], "至少指定一个"],
  [["update", "E-1", "--role", ""], "不能为空"],
  [["update", "E-1", "--title", "新职位"], "不存在"],
  [["activate", "E-1"], "不存在"],
  [["deactivate", "E-1"], "不存在"],
  [["activate", "E-01"], "员工编号必须"],
  [["delete", "E-1"], "有效的员工命令"],
])(
  "invalid employee command %j gives a Chinese error and changes nothing",
  async (args, message) => {
    const before = snapshot();
    expect(await run(args)).not.toBe(0);
    expect(errors.join("\n")).toContain(message);
    expect(snapshot()).toEqual(before);
  },
);

test("--projects round trips multiple memberships; omitted preserves and empty clears", async () => {
  expect(await run([...add, "--projects", "one, two"])).toBe(0);
  expect(await run(["update", "E-1", "--title", "架构师"])).toBe(0);
  expect(snapshot().employees[0]?.projects).toEqual(["one", "two"]);
  expect(await run(["update", "E-1", "--projects=two,one,one"])).toBe(2);
  expect(await run(["update", "E-1", "--projects=two"])).toBe(0);
  expect(snapshot().employees[0]?.projects).toEqual(["two"]);
  expect(await run(["update", "E-1", "--projects="])).toBe(0);
  expect(snapshot().employees[0]?.projects).toEqual([]);
});

test("transfer checks the latest role in every project, not the CLI project or an obsolete version", async () => {
  expect(await run(add)).toBe(0);
  const change = ["update", "E-1", "--role", "coder"];
  const before = snapshot();
  const role = {
    role_id: "coder",
    role_version: 1,
    allowed_tools: [],
    capabilities: [],
  };
  store.createProject({ id: "one" });
  store.createProject({ id: "two" });
  io.env.CARDIGAN_PROJECT = "one";
  expect(await run(change)).toBe(2);
  store.uow.run((tx) => {
    tx.roles.put("one", role);
    tx.roles.put("one", { ...role, role_version: 2, status: "inactive" });
  });
  expect(await run(change)).toBe(2);
  expect(snapshot()).toEqual(before);
  store.uow.run((tx) => tx.roles.put("two", role)); // Legacy status omitted = active.
  expect(await run(change)).toBe(0);
  expect(output.join("\n")).toContain("角色：coder");
  expect(snapshot().events.at(-1)).toMatchObject({
    type: "employee_role_changed",
    payload: {
      changed_by_member_id: "M-1",
      from_role_id: "pm",
      to_role_id: "coder",
    },
  });
});
