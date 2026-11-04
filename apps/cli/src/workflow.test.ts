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

test("office and ops are separate standing assignments with independent tokens", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--office"])).toBe(0);
  const officeToken = tokenFromOutput();
  expect(printed()).toContain("已创建常驻 PM Office：A-1");

  // Ops is a second standing assignment of the same pm role, not a downgrade
  // of the Office one (§7.1, §10.4).
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  const opsToken = tokenFromOutput();
  expect(printed()).toContain("已创建常驻 PM Ops：A-2");

  const store = Store.open({ dataDir });
  try {
    const standing = store.uow.read((tx) =>
      tx.assignments
        .list("p-work" as never)
        .filter((a) => a.scope === "standing"),
    );
    expect(standing.map((a) => a.id).sort()).toEqual(["A-1", "A-2"]);
    expect(store.verifyToken(officeToken)?.allowed_tools).toContain(
      "record_decision",
    );
    expect(store.verifyToken(opsToken)?.allowed_tools ?? []).not.toContain(
      "record_decision",
    );
  } finally {
    store.close();
  }

  // Re-issuing the Office token leaves the Ops token alone, and vice versa.
  expect(await run(["token", "issue", "A-1"])).toBe(0);
  const rotatedOffice = tokenFromOutput();
  const reopened = Store.open({ dataDir });
  try {
    expect(reopened.verifyToken(officeToken)).toBeUndefined();
    expect(reopened.verifyToken(rotatedOffice)).toBeDefined();
    expect(reopened.verifyToken(opsToken)).toBeDefined();
  } finally {
    reopened.close();
  }

  expect(await run(["token", "issue", "A-2"])).toBe(0);
  const rotatedOps = tokenFromOutput();
  const again = Store.open({ dataDir });
  try {
    expect(again.verifyToken(opsToken)).toBeUndefined();
    expect(again.verifyToken(rotatedOffice)).toBeDefined();
    expect(again.verifyToken(rotatedOps)).toBeDefined();
    expect(again.verifyToken(rotatedOps)?.allowed_tools ?? []).not.toContain(
      "record_decision",
    );
  } finally {
    again.close();
  }

  // Asking for --ops again reuses the Ops assignment instead of adding a third.
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  expect(printed()).toContain("复用常驻 PM Ops：A-2");
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

test("assign --start hands off without printing a token", async () => {
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

  const calls: Array<{ assignment_id: string; project_id: string }> = [];
  const code = await main(["assign", "W-1", "--role", "coder", "--start"], io, {
    start: async (options) => {
      calls.push({
        assignment_id: options.assignment_id,
        project_id: options.project_id,
      });
      options.io.stdout(`已启动 ${options.assignment_id}`);
      return 0;
    },
  });

  expect(code).toBe(0);
  expect(calls).toEqual([{ assignment_id: "A-1", project_id: "p-work" }]);
  // One command from a card to a running Agent: the token lives in the run
  // directory only, so nothing token-shaped is printed here.
  expect(printed()).toContain("已启动 A-1");
  expect(printed()).not.toContain("token_id");
  expect(printed()).not.toContain("Token");

  // No token was issued outside the run directory either.
  const store = Store.open({ dataDir });
  try {
    expect(
      store.uow.run((tx) =>
        tx.tokensForAssignment("p-work" as never, "A-1" as never),
      ),
    ).toHaveLength(0);
  } finally {
    store.close();
  }
});
