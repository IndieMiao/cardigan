import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HumanAction, requestHumanAction } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCommand } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string;
let output: string[];
let errors: string[];
let io: CliIo;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-workflow-"));
  output = [];
  errors = [];
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("workflow commands must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<number> {
  output = [];
  errors = [];
  return main(argv, io);
}

function printed(): string {
  return output.join("\n");
}

function tokenFromOutput(): string {
  const lines = printed()
    .split("\n")
    .map((line) => line.trim());
  const index = lines.findIndex((line) => line.startsWith("token_id："));
  const token = lines[index + 2];
  if (token === undefined) throw new Error(`no token in:\n${printed()}`);
  return token;
}

async function bootstrap(project = "p-work"): Promise<void> {
  expect(await run(["init"])).toBe(0);
  expect(await run(["project", "create", project])).toBe(0);
  expect(
    await run([
      "role",
      "add",
      project,
      "pm",
      "--allowed-tools",
      "create_card,assign,record_decision,submit_review",
    ]),
  ).toBe(0);
  expect(
    await run([
      "role",
      "add",
      project,
      "coder",
      "--allowed-tools",
      "submit_delivery,post_comment,get_card",
    ]),
  ).toBe(0);
}

test("card create builds a dev card and lists its work items", async () => {
  await bootstrap();
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Fictional card",
      "--goal",
      "Prove the CLI",
      "--acceptance",
      "tests pass;docs updated",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
  expect(printed()).toContain("已创建卡片 C-1");
  expect(printed()).toContain("W-1  produce  coder");
  expect(printed()).toContain("W-2  verify  reviewer");
  expect(printed()).toContain("W-3  verify  pm");

  // Only the dev template exists in M1.
  expect(
    await run([
      "card",
      "create",
      "--template",
      "bug",
      "--title",
      "x",
      "--goal",
      "x",
      "--acceptance",
      "x",
      "--repo",
      "x",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("dev 模板");
});

test("the project falls back to CARDIGAN_PROJECT and complains when ambiguous", async () => {
  await bootstrap("p-one");
  expect(await run(["project", "create", "p-two"])).toBe(0);
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "x",
      "--goal",
      "x",
      "--acceptance",
      "x",
      "--repo",
      "x",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("--project");

  io.env.CARDIGAN_PROJECT = "p-two";
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "x",
      "--goal",
      "x",
      "--acceptance",
      "x",
      "--repo",
      "x",
    ]),
  ).toBe(0);
  expect(printed()).toContain("已创建卡片 C-1");
});

test("assign issues a token once and re-assigning rotates it", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  expect(await run(["assign", "W-1", "--role", "coder"])).toBe(0);
  const first = tokenFromOutput();
  expect(printed()).toContain("已指派 W-1 → A-1");

  const store = Store.open({ dataDir });
  try {
    // The plaintext token is nowhere in the database; only its hash is stored.
    expect(store.verifyToken(first)).toBeDefined();
  } finally {
    store.close();
  }

  expect(await run(["assign", "W-1", "--role", "coder"])).toBe(0);
  const second = tokenFromOutput();
  expect(second).not.toBe(first);
  const reopened = Store.open({ dataDir });
  try {
    // Re-assigning keeps one assignment and revokes the previous token.
    expect(reopened.verifyToken(first)).toBeUndefined();
    expect(reopened.verifyToken(second)).toBeDefined();
  } finally {
    reopened.close();
  }
});

test("token issue validates the assignment and its state", async () => {
  await bootstrap();
  expect(await run(["token", "issue", "A-99"])).toBe(2);
  expect(errors.join("\n")).toContain("不存在");
  expect(await run(["token", "issue", "not-an-id"])).toBe(2);
  expect(errors.join("\n")).toContain("不合法");
});

test("pm create --ops drops record_decision and needs the role to have it", async () => {
  expect(await run(["init"])).toBe(0);
  await run(["project", "create", "p-work"]);
  await run([
    "role",
    "add",
    "p-work",
    "pm",
    "--allowed-tools",
    "create_card,assign",
  ]);

  // Without record_decision in the role, the two modes cannot be told apart.
  expect(await run(["pm", "create", "--ops"])).toBe(2);
  expect(errors.join("\n")).toContain("record_decision");

  await run([
    "role",
    "add",
    "p-work",
    "pm",
    "--version",
    "2",
    "--allowed-tools",
    "create_card,assign,record_decision",
  ]);
  // The newest pm role version now allows both modes.
  expect(await run(["pm", "create", "--ops", "--project", "p-work"])).toBe(0);
  expect(printed()).toContain("allowed_tools：create_card, assign");
});

test("human-action done completes the action and requires --text", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  await run(["assign", "W-1", "--role", "coder"]);

  const store = Store.open({ dataDir });
  let action: HumanAction;
  try {
    action = runCommand(store, {
      project_id: "p-work" as never,
      actor: { kind: "human", project_id: "p-work" as never },
      reduce: (state, actor, ports) =>
        requestHumanAction(
          state,
          actor,
          {
            card_id: "C-1" as never,
            instructions: "Fictional manual step",
            why_human: "needs a credential",
            expected_return: "confirmation",
            blocked_work_items: [],
          },
          ports,
        ),
    });
  } finally {
    store.close();
  }

  expect(await run(["human-action", "done", action.id])).toBe(2);
  expect(errors.join("\n")).toContain("--text");

  expect(
    await run([
      "human-action",
      "done",
      action.id,
      "--text",
      "fictional result",
    ]),
  ).toBe(0);
  expect(printed()).toContain(`已完成 ${action.id}：done`);

  const reopened = Store.open({ dataDir });
  try {
    const stored = reopened.uow.read((tx) =>
      tx.human_actions.get("p-work" as never, action.id),
    );
    expect(stored?.status).toBe("done");
    expect(stored?.result?.text).toBe("fictional result");
  } finally {
    reopened.close();
  }
});

test("assign rejects a role that does not match the work item", async () => {
  await bootstrap();
  await run([
    "card",
    "create",
    "--template",
    "dev",
    "--title",
    "T",
    "--goal",
    "G",
    "--acceptance",
    "A",
    "--repo",
    "r/x",
  ]);
  expect(await run(["assign", "W-1", "--role", "reviewer"])).toBe(2);
  expect(errors.join("\n")).toContain("role");
});
