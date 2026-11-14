import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Assignment, type ToolName, toolNames } from "@cardigan/domain";
import { authenticate } from "@cardigan/mcp-server";
import { recordNotification, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CLI_TOOLS } from "./command-access.js";
import { resolveActor } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { registerTemplateRoles } from "./template-fixtures.js";

const project = "token-project";
let dir: string;
let store: Store;
let io: CliIo;
let output: string[];
let errors: string[];
let assignment: Assignment;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cardigan-token-mode-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: project, name: "Token fixture" });
  store.uow.run((tx) =>
    tx.roles.put(project, {
      role_id: "pm",
      role_version: 1,
      allowed_tools: toolNames,
      capabilities: [],
    }),
  );
  registerTemplateRoles(store, project);
  output = [];
  errors = [];
  io = {
    cwd: dir,
    env: { CARDIGAN_DATA_DIR: dir },
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("Token commands must not spawn");
    },
    captureCommand: async () => {
      throw new Error("Token commands must not capture");
    },
  };
  expect(
    await main(
      [
        "card",
        "create",
        "--title",
        "Fixture",
        "--goal",
        "Identity",
        "--acceptance",
        "Access control",
        "--repo",
        "example/repo",
      ],
      io,
    ),
  ).toBe(0);
  assignment = store.uow.run((tx) => {
    const row: Assignment = {
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode: "office",
      external: true,
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "fixture",
      created_at: new Date().toISOString(),
    };
    tx.assignments.put(project, row);
    return row;
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function issue(allowed_tools: readonly ToolName[] = toolNames) {
  return store.issueToken({
    project_id: project,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools },
  });
}
function tokenIo(token: string): CliIo {
  return { ...io, env: { ...io.env, CARDIGAN_TOKEN: token } };
}
async function run(args: string[], input = io) {
  output.length = 0;
  errors.length = 0;
  return main(args, input);
}
const update = ["card", "update", "C-1", "--title", "Changed"];
const comment = ["comment", "add", "C-1", "--text", "Identity check"];
const accessCases = Object.entries(CLI_TOOLS);

test.each(["office", "ops"])(
  "%s Token cannot alter precheck waiting, independent review authorization or its budget",
  async (mode) => {
    const token = mode === "ops" ? opsIdentity() : issue().token;
    for (const [key, input] of [
      ["code-review-waits-for-precheck", "on"],
      ["code-review-waits-for-precheck", "off"],
      ["independent-review-limit-delegation", "on"],
      ["independent-review-limit-delegation", "off"],
      ["independent-review-limit-delegation-max", "3"],
    ] as const)
      expect(
        await run(["preference", "set", key, input], tokenIo(token)),
      ).not.toBe(0);
    expect(
      store.uow.read((tx) => tx.project_preferences.list(project)),
    ).toEqual([]);
  },
);

async function releaseTarget() {
  expect(await run(["assign", "W-1", "--role", "coder"])).toBe(0);
  const target = store.uow
    .read((tx) => tx.assignments.list(project))
    .find((a) => a.scope === "work_item" && a.work_item_id === "W-1");
  if (!target) throw new Error("Missing target Assignment");
  return target;
}

function opsIdentity() {
  assignment = store.uow.run((tx) => {
    const ops: Assignment = {
      ...assignment,
      id: tx.ids.next(project, "assignment"),
      external: false,
      standing_mode: "ops",
    };
    tx.assignments.put(project, ops);
    return ops;
  });
  return issue(["release_assignment"]).token;
}

test.each(["human", "ops"] as const)(
  "%s can release through CLI without a runtime, and repeating is harmless",
  async (caller) => {
    const target = await releaseTarget();
    const input = caller === "ops" ? tokenIo(opsIdentity()) : io;
    for (let i = 0; i < 2; i++) {
      expect(await run(["assignment", "release", target.id], input)).toBe(0);
      expect(output.join("\n")).toContain(`已释放 Assignment ${target.id}`);
    }
    expect(
      store.uow.read((tx) => tx.assignments.get(project, target.id))?.status,
    ).toBe("released");
    expect(
      store.uow
        .read((tx) => tx.events.listAfter(project, "C-1" as never, 0))
        .filter((e) => e.type === "assignment_released"),
    ).toHaveLength(1);
  },
);

test("CLI checks Office identity even when its Token contains release_assignment", async () => {
  const target = await releaseTarget();
  expect(
    await run(
      ["assignment", "release", target.id],
      tokenIo(issue(["release_assignment"]).token),
    ),
  ).toBe(2);
  expect(errors.join("\n")).toContain("unauthorized");
  expect(
    store.uow.read((tx) => tx.assignments.get(project, target.id))?.status,
  ).toBe("active");
});

test("only human can release a standing Assignment through CLI", async () => {
  const office = assignment;
  const ops = opsIdentity();
  expect(await run(["assignment", "release", office.id], tokenIo(ops))).toBe(2);
  expect(errors.join("\n")).toContain("unauthorized");
  expect(await run(["assignment", "release", office.id])).toBe(0);
  expect(
    store.uow.read((tx) => tx.assignments.get(project, office.id))?.status,
  ).toBe("released");
});

test("CLI release with an unfinished Run explains the stop command and keeps state", async () => {
  const target = await releaseTarget();
  store.uow.run((tx) =>
    tx.runs.put(project, {
      id: tx.ids.next(project, "run"),
      assignment_id: target.id,
      trigger_event_id: tx.ids.nextEventId(),
      kind: "initial",
      status: "queued",
      role_version: 1,
      model: "fixture",
      agent_cli_version: "1",
      outcome: null,
      summary: "",
    }),
  );
  expect(await run(["assignment", "release", target.id])).toBe(2);
  expect(errors.join("\n")).toContain(`cardigan assignment stop ${target.id}`);
  expect(
    store.uow.read((tx) => tx.assignments.get(project, target.id))?.status,
  ).toBe("active");
});

test.each(accessCases)("command permission: %s → %s", async (command, tool) => {
  const token = issue(
    tool === null ? toolNames : toolNames.filter((name) => name !== tool),
  ).token;
  expect(await run(command.split(" "), tokenIo(token))).toBe(2);
  expect(errors.join("\n")).toContain(
    tool === null ? "仅限人类" : `无权调用工具 ${tool}`,
  );
  expect(output).toEqual([]);
  expect(errors.join("\n").includes(token)).toBe(false);
});

test("unknown future command is human-only, and source entrypoints never call humanActor", async () => {
  expect(await run(["future-command"], tokenIo(issue().token))).toBe(2);
  expect(errors.join("\n")).toContain("仅限人类");
  for (const file of [
    "role",
    "merge",
    "employee",
    "member",
    "template",
    "pm-rotate",
    "workflow",
    "content",
    "assignment",
    "worktree",
    "preference",
  ])
    expect(
      readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8"),
    ).not.toMatch(/humanActor\s*\(/u);
});

test("C-288: the removed snapshot command stays denied in Token mode", async () => {
  expect(CLI_TOOLS).not.toHaveProperty("review-snapshot create");
  expect(await run(["review-snapshot", "create"], tokenIo(issue().token))).toBe(
    2,
  );
  expect(errors.join("\n")).toContain("仅限人类");
  expect(output).toEqual([]);
});

test("resolveActor matches MCP identity and authenticates the token's tool scope", () => {
  const token = issue([
    "post_comment",
    "get_updates",
    "issue_instruction",
  ]).token;
  const identity = authenticate(store, token);
  expect(identity.ok).toBe(true);
  if (!identity.ok) throw new Error("fixture identity missing");
  expect(resolveActor(tokenIo(token), project, store)).toEqual(
    identity.value.actor,
  );
  expect(identity.value.actor.allowed_tools).toEqual([
    "post_comment",
    "get_updates",
  ]);
  expect(resolveActor(io, project, store)).toEqual({
    kind: "human",
    project_id: project,
  });
});

test.each(["invalid", "empty", "revoked", "suspended", "released"])(
  "%s credentials fail without a human fallback",
  async (state) => {
    const issued = issue();
    const token =
      state === "invalid"
        ? randomBytes(32).toString("hex")
        : state === "empty"
          ? ""
          : issued.token;
    if (state === "revoked") store.revokeToken(issued.record.id);
    if (state === "suspended" || state === "released")
      store.uow.run((tx) =>
        tx.assignments.put(project, { ...assignment, status: state }),
      );
    expect(await run(update, tokenIo(token))).toBe(2);
    expect(errors.join("\n")).toContain("Token 无效");
    expect(output).toEqual([]);
    expect(
      store.uow.read((tx) => tx.cards.get(project, "C-1" as never)?.title),
    ).toBe("Fixture");
  },
);

test("valid token writes assignment authors; no token keeps human authors", async () => {
  const token = issue(["post_comment", "update_card"]).token;
  expect(await run(comment, tokenIo(token)), errors.join("\n")).toBe(0);
  expect(
    store
      .getUpdates({ project_id: project, card_id: "C-1" as never })
      .timeline.at(-1)?.author,
  ).toBe(`assignment:${assignment.id}`);
  expect(await run(update, tokenIo(token))).toBe(0);
  expect(
    store
      .getUpdates({ project_id: project, card_id: "C-1" as never })
      .events.at(-1)?.actor,
  ).toMatchObject({ kind: "assignment", assignment_id: assignment.id });
  expect(await run(comment)).toBe(0);
  expect(
    store
      .getUpdates({ project_id: project, card_id: "C-1" as never })
      .timeline.at(-1)?.author,
  ).toBe("human");
});

test("risk tags reuse the update_card PM gate for tokens", async () => {
  const coder = store.uow.run((tx) => {
    const row: Assignment = {
      ...assignment,
      id: tx.ids.next(project, "assignment"),
      role_id: "coder",
    };
    tx.assignments.put(project, row);
    return row;
  });
  const coderToken = store.issueToken({
    project_id: project,
    assignment_id: coder.id,
    role: { role_version: 1, allowed_tools: ["update_card"] },
  }).token;
  const tags = ["card", "update", "C-1", "--risk-tags", "security"];
  expect(await run(tags, tokenIo(coderToken))).toBe(2);
  expect(
    store.uow.read((tx) => tx.cards.get(project, "C-1" as never)?.risk_tags),
  ).toBeUndefined();
  const pmToken = issue(["update_card"]).token;
  expect(await run(tags, tokenIo(pmToken)), errors.join("\n")).toBe(0);
  expect(
    store.uow.read((tx) => tx.cards.get(project, "C-1" as never)?.risk_tags),
  ).toEqual(["security"]);
});

test("project selectors cannot escape the token project", async () => {
  store.createProject({ id: "another", name: "Other project" });
  const token = issue().token;
  expect(await run([...update, "--project", "another"], tokenIo(token))).toBe(
    2,
  );
  expect(errors.join("\n")).toContain("无权访问此项目");
  expect(
    await run([...update, "--project", project], tokenIo(token)),
    errors.join("\n"),
  ).toBe(0);
});

test.each([0o400, 0o644, 0o660, 0o700, 0o4600])(
  "token file mode %s is rejected before reading",
  async (mode) => {
    const path = join(dir, "credential");
    const secret = issue().token;
    writeFileSync(path, secret, { mode: 0o600 });
    chmodSync(path, mode);
    expect(await run(["--token-file", path, ...update])).toBe(2);
    expect(errors.join("\n")).toContain("0600");
    expect(errors.join("\n").includes(secret)).toBe(false);
  },
);

test("0600 token file works before or after command, with relative and inline paths", async () => {
  writeFileSync(join(dir, "credential"), `${issue().token}\n`, { mode: 0o600 });
  expect(await run(["--token-file", "credential", ...comment])).toBe(0);
  expect(await run([...update, "--token-file=credential"])).toBe(0);
});

test("conflicting, duplicate, missing, empty and linked token files fail closed", async () => {
  const path = join(dir, "credential");
  writeFileSync(path, "", { mode: 0o600 });
  symlinkSync(path, join(dir, "linked"));
  expect(
    await run([...update, "--token-file", path], tokenIo(issue().token)),
  ).toBe(2);
  expect(errors.join("\n")).toContain("不能同时提供");
  expect(await run([...update, "--token-file", path], tokenIo(""))).toBe(2);
  expect(errors.join("\n")).toContain("不能同时提供");
  for (const file of [path, join(dir, "missing"), join(dir, "linked"), dir])
    expect(await run([...update, "--token-file", file])).toBe(2);
  expect(
    await run([...update, "--token-file", path, "--token-file", path]),
  ).toBe(2);
  expect(await run([...update, "--token-file"])).toBe(2);
});

test("inbox is restricted to exact Assignment recipients, excluding logical PM and other assignments", async () => {
  store.uow.run((tx) => {
    for (const recipient of [
      { kind: "assignment", assignment_id: assignment.id },
      { kind: "assignment", assignment_id: "A-99" },
      { kind: "pm_office" },
      { kind: "pm_ops" },
    ] as const) {
      const event = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, "C-1" as never),
        card_id: "C-1" as never,
        type: "comment_posted",
        actor: { kind: "human" as const, project_id: project },
        payload: {},
        created_at: new Date().toISOString(),
      };
      tx.events.append(project, event);
      recordNotification(store.database, {
        project_id: project,
        event_id: event.id,
        card_id: event.card_id,
        seq: event.seq,
        kind: "comment",
        recipient: recipient as never,
        at: event.created_at,
      });
    }
  });
  const input = tokenIo(issue(["get_updates"]).token);
  expect(await run(["inbox"], input)).toBe(0);
  expect(output.join("\n")).toContain(`assignment:${assignment.id}`);
  expect(output.join("\n")).not.toMatch(/A-99|pm_office|pm_ops/u);
  expect(await run(["inbox", "--assignment", assignment.id], input)).toBe(0);
  expect(await run(["inbox", "--assignment", "A-99"], input)).toBe(2);
  expect(errors.join("\n")).toContain("不能指定其他 --assignment");
  expect(output).toEqual([]);
  expect(await run(["inbox"])).toBe(0);
  expect(output.join("\n")).toMatch(/A-99/u);
  expect(output.join("\n")).toMatch(/pm_office/u);
});

test("assign cannot issue or rotate another Assignment's token, and rejects --start", async () => {
  const input = tokenIo(issue(["assign"]).token);
  const args = ["assign", "W-1", "--role", "coder"];
  expect(await run([...args, "--start"], input)).toBe(2);
  expect(store.uow.read((tx) => tx.assignments.list(project))).toHaveLength(1);
  expect(await run(args, input), errors.join("\n")).toBe(0);
  expect(output.join("\n")).toContain("pending_host_issuance");
  expect(output.join("\n")).not.toContain("token_id：");
  const created = store.uow.read((tx) =>
    tx.assignments.list(project).find((a) => a.scope === "work_item"),
  );
  if (!created) throw new Error("assignment missing");
  expect(
    store.uow.run((tx) => tx.tokensForAssignment(project, created.id)),
  ).toHaveLength(0);
  const existing = store.issueToken({
    project_id: project,
    assignment_id: created.id,
    role: { role_version: 1, allowed_tools: ["get_card"] },
  });
  expect(await run(args, input), errors.join("\n")).toBe(0);
  expect(
    store.uow.run((tx) => tx.tokensForAssignment(project, created.id)),
  ).toHaveLength(1);
  expect(store.verifyToken(existing.token)).toBeDefined();
});

test("needs-you uses list_needs_you without requiring project_snapshot", async () => {
  expect(
    await run(["needs-you"], tokenIo(issue(["list_needs_you"]).token)),
    errors.join("\n"),
  ).toBe(0);
  expect(JSON.parse(output.join("\n"))).toHaveProperty("decisions");
});

test("compound uploads require every tool before reading or writing blobs", async () => {
  expect(
    await run(
      [...comment, "--file", "does-not-exist.txt"],
      tokenIo(issue(["post_comment"]).token),
    ),
  ).toBe(2);
  expect(errors.join("\n")).toContain("upload_attachment");
  expect(
    await run(
      ["attachment", "add", "C-1", "--file", "does-not-exist.txt"],
      tokenIo(issue(["upload_attachment"]).token),
    ),
  ).toBe(2);
  expect(errors.join("\n")).toContain("post_comment");
});
