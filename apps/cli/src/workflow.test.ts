import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HumanAction,
  queueRun,
  recordDecision,
  requestDecision,
  requestHumanAction,
} from "@cardigan/domain";
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
  expect(errors.join("\n")).toContain(
    "无法签发 Token A-99：Assignment A-99 不存在（not_found）",
  );
  expect(await run(["token", "issue", "not-an-id"])).toBe(2);
  expect(errors.join("\n")).toContain("不合法");
});

test("human-action reports domain rejection in Chinese with the same exit code", async () => {
  await bootstrap();
  expect(await run(["human-action", "done", "h(99)", "--text", "done"])).toBe(
    2,
  );
  expect(errors.join("\n")).toContain(
    "无法完成待办操作 h(99)：对象在当前项目中不存在（not_found）",
  );
  expect(printed()).toBe("");
});

test("P2a-6: CLI assign separates authors, reviewers and PM acceptance and rejects a borrowed identity", async () => {
  await bootstrap();
  expect(
    await run([
      "role",
      "add",
      "p-work",
      "reviewer",
      "--allowed-tools",
      "submit_review",
    ]),
  ).toBe(0);
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Identity separation",
      "--goal",
      "Independent review",
      "--acceptance",
      "Distinct assignments",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
  const roles = ["coder", "reviewer", "pm"];
  const tokens: string[] = [];
  for (const [index, role] of roles.entries()) {
    expect(await run(["assign", `W-${index + 1}`, "--role", role])).toBe(0);
    expect(printed()).toContain(`已指派 W-${index + 1} → A-${index + 1}`);
    tokens.push(tokenFromOutput());
  }

  const store = Store.open({ dataDir });
  try {
    store.uow.run((tx) => {
      expect(
        tx.assignments.list("p-work").map((a) => [a.id, a.work_item_id]),
      ).toEqual([
        ["A-1", "W-1"],
        ["A-2", "W-2"],
        ["A-3", "W-3"],
      ]);
      const reviewer = tx.work_items.get("p-work", "W-2" as never);
      if (!reviewer) throw new Error("Missing reviewer");
      // No CLI option reuses an identity; simulate a conflicting stored link.
      tx.work_items.put("p-work", {
        ...reviewer,
        assignment_id: "A-1" as never,
      });
    });
  } finally {
    store.close();
  }

  expect(await run(["assign", "W-2", "--role", "reviewer"])).toBe(2);
  expect(errors.join("\n")).toContain(
    "无法指派工作项 W-2：这个工作项已经有负责的 Assignment，不能再指派新的（invariant_violation）",
  );
  expect(printed()).toBe("");
  const reopened = Store.open({ dataDir });
  try {
    // Rejection must not rotate any credentials or rebind either Assignment.
    for (const [index, token] of tokens.entries()) {
      expect(reopened.verifyToken(token)?.assignment_id).toBe(`A-${index + 1}`);
    }
    expect(
      reopened.uow.read((tx) => tx.assignments.list("p-work")),
    ).toHaveLength(3);
  } finally {
    reopened.close();
  }
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
  expect(errors.join("\n")).toContain("指派的角色必须与工作项要求一致");
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

/** Create the two standing PM assignments (Office and Ops). */
async function createPmPair(): Promise<void> {
  await run(["init"]);
  await run(["project", "create", "p-work"]);
  await run([
    "role",
    "add",
    "p-work",
    "pm",
    "--allowed-tools",
    "create_card,assign,record_decision",
  ]);
  expect(await run(["pm", "create", "--office", "--project", "p-work"])).toBe(
    0,
  );
  expect(await run(["pm", "create", "--ops", "--project", "p-work"])).toBe(0);
}

test("pm start launches Office and Ops through the one-command start", async () => {
  await createPmPair();

  const calls: string[] = [];
  const code = await main(["pm", "start", "--project", "p-work"], io, {
    start: async (options) => {
      calls.push(options.assignment_id);
      options.io.stdout(`started ${options.assignment_id}`);
      return 0;
    },
  });

  expect(code).toBe(0);
  // Both standing assignments, in creation order.
  expect(calls).toEqual(["A-1", "A-2"]);
  expect(printed()).toContain("已启动 2 个常驻 PM");
  expect(printed()).toContain("started A-1");
  expect(printed()).toContain("started A-2");
});

test("pm start skips a PM that already has an unfinished Run", async () => {
  await createPmPair();
  const store = Store.open({ dataDir });
  try {
    runCommand(store, {
      project_id: "p-work" as never,
      actor: { kind: "human", project_id: "p-work" as never },
      reduce: (state, actor, ports) =>
        queueRun(
          state,
          actor,
          {
            assignment_id: "A-1" as never,
            model: "fixture-model",
            agent_cli_version: "pi 1.5.0",
          },
          ports,
        ),
    });
  } finally {
    store.close();
  }

  const calls: string[] = [];
  const code = await main(["pm", "start", "--project", "p-work"], io, {
    start: async (options) => {
      calls.push(options.assignment_id);
      return 0;
    },
  });

  expect(code).toBe(0);
  expect(calls).toEqual(["A-2"]);
  expect(printed()).toContain("PM Office（A-1）已在运行，跳过");
});

test("pm start can start one mode and refuses when no PM exists", async () => {
  await createPmPair();

  const calls: string[] = [];
  expect(
    await main(["pm", "start", "--ops", "--project", "p-work"], io, {
      start: async (options) => {
        calls.push(options.assignment_id);
        return 0;
      },
    }),
  ).toBe(0);
  expect(calls).toEqual(["A-2"]);

  // A fresh project has no standing PM assignments yet.
  expect(await run(["project", "create", "p-other"])).toBe(0);
  expect(await run(["pm", "start", "--project", "p-other"])).toBe(2);
  expect(errors.join("\n")).toContain("pm create");
});

test("needs-you lists open human decisions and pending human actions", async () => {
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
  // Recording a decision is PM Office's job (§10.4), so the test needs one.
  await run(["pm", "create", "--office", "--project", "p-work"]);

  const store = Store.open({ dataDir });
  try {
    const human = { kind: "human", project_id: "p-work" as never } as const;
    const office = store.uow.read((tx) =>
      tx.assignments
        .list("p-work" as never)
        .find((candidate) => candidate.scope === "standing"),
    );
    if (office === undefined) throw new Error("no PM Office assignment");
    const decision = runCommand(store, {
      project_id: "p-work" as never,
      actor: human,
      reduce: (state, actor, ports) =>
        requestDecision(
          state,
          actor,
          {
            card_id: "C-1" as never,
            category: "general",
            kind: "choose",
            question: "Which shape should the API take?",
            context: "Two options look reasonable",
            options: [
              { key: "a", description: "REST", impact: "Simpler" },
              { key: "b", description: "RPC", impact: "Faster" },
            ],
            recommended: "a",
            affected_cards: ["C-1" as never],
            affected_work_items: ["W-1" as never],
            blocking: false,
            decider: "human",
          },
          ports,
        ),
    });
    const action = runCommand(store, {
      project_id: "p-work" as never,
      actor: human,
      reduce: (state, actor, ports) =>
        requestHumanAction(
          state,
          actor,
          {
            card_id: "C-1" as never,
            instructions: "Connect the device",
            why_human: "Only a human has hands",
            expected_return: "a photo",
            blocked_work_items: [],
          },
          ports,
        ),
    });
    // A decision for a role never shows up here.
    runCommand(store, {
      project_id: "p-work" as never,
      actor: human,
      reduce: (state, actor, ports) =>
        requestDecision(
          state,
          actor,
          {
            card_id: "C-1" as never,
            category: "general",
            kind: "choose",
            question: "Internal choice",
            context: "PM decides",
            options: [
              { key: "a", description: "Do it", impact: "Faster" },
              { key: "b", description: "Skip", impact: "Cheaper" },
            ],
            recommended: "a",
            affected_cards: ["C-1" as never],
            affected_work_items: [],
            blocking: false,
            decider: "role:pm",
          },
          ports,
        ),
    });

    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    const text = printed();
    expect(text).toContain(decision.id);
    expect(text).toContain("Which shape should the API take?");
    expect(text).toContain(action.id);
    expect(text).toContain("Connect the device");
    expect(text).toContain("Only a human has hands");
    expect(text).toContain("a photo");
    expect(text).not.toContain("Internal choice");

    // Answering the decision clears it from the view; only Office may record it.
    runCommand(store, {
      project_id: "p-work" as never,
      actor: {
        kind: "assignment",
        project_id: "p-work" as never,
        assignment_id: office.id,
        role_id: office.role_id,
        role_version: office.role_version,
        allowed_tools: ["record_decision"],
      } as never,
      reduce: (state, actor, ports) =>
        recordDecision(
          state,
          actor,
          {
            decision_id: decision.id,
            option: "a",
            rationale: "REST is simpler",
            raw_quote: "选 A",
          },
          ports,
        ),
    });
    expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
    expect(printed()).not.toContain("Which shape should the API take?");
    expect(printed()).toContain("Connect the device");
  } finally {
    store.close();
  }
});

test("needs-you says so when nothing is waiting for the human", async () => {
  await bootstrap();
  expect(await run(["needs-you", "--project", "p-work"])).toBe(0);
  expect(printed()).toContain("Needs You 是空的");
});

test("M4.5: pm create writes the standing mode once and never changes it", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  const store = Store.open({ dataDir });
  try {
    expect(
      store.uow.read((tx) =>
        tx.assignments.get("p-work" as never, "A-1" as never),
      )?.standing_mode,
    ).toBe("ops");
  } finally {
    store.close();
  }

  // Asking for Office later does not promote the Ops Assignment; it seats the
  // second standing Assignment, and Ops keeps its mode.
  expect(await run(["pm", "create", "--office"])).toBe(0);
  const reopened = Store.open({ dataDir });
  try {
    expect(
      reopened.uow.read((tx) =>
        tx.assignments
          .list("p-work" as never)
          .filter((assignment) => assignment.scope === "standing")
          .map((assignment) => [assignment.id, assignment.standing_mode]),
      ),
    ).toEqual([
      ["A-1", "ops"],
      ["A-2", "office"],
    ]);
  } finally {
    reopened.close();
  }
});

test("M4.5: a legacy standing row is inferred from its newest token once", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  const opsToken = tokenFromOutput();

  // Simulate a row written before the field existed: same token, no mode.
  const store = Store.open({ dataDir });
  try {
    store.uow.run((tx) => {
      const current = tx.assignments.get("p-work" as never, "A-1" as never);
      if (current === undefined) throw new Error("missing assignment");
      const { standing_mode, ...legacy } = current;
      void standing_mode;
      tx.assignments.put("p-work" as never, legacy);
    });
  } finally {
    store.close();
  }

  expect(await run(["token", "issue", "A-1"])).toBe(0);
  const rotated = tokenFromOutput();
  const reopened = Store.open({ dataDir });
  try {
    expect(
      reopened.uow.read((tx) =>
        tx.assignments.get("p-work" as never, "A-1" as never),
      )?.standing_mode,
    ).toBe("ops");
    expect(reopened.verifyToken(opsToken)).toBeUndefined();
    expect(reopened.verifyToken(rotated)?.allowed_tools ?? []).not.toContain(
      "record_decision",
    );
  } finally {
    reopened.close();
  }
});
