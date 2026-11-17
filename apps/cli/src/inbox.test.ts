import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveNotification, recordNotification, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { attentionCommand, inboxCommand } from "./inbox.js";
import type { CliIo } from "./io.js";

/** M3.5 read-only views over the inbox and the escalations. */

let dataDir: string;
let store: Store;
let output: string[];
let io: CliIo;
const project = "p-inbox";

const coder = {
  id: "A-1",
  scope: "work_item",
  work_item_id: "W-1",
  role_id: "coder",
  role_version: 1,
  status: "active",
  runtime_state: "running",
  machine_id: "local",
  runtime_ref: {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "coder-1",
  },
  mcp_token_id: "fixture",
  created_at: "2030-01-01T00:00:00.000Z",
};

const card = {
  id: "C-1",
  project_id: project,
  title: "Routing card",
  template: "dev",
  status: "in_progress",
};

function seed(): void {
  store.createProject({ id: project as never, name: "Inbox" });
  store.uow.run((tx) => {
    tx.cards.put(project as never, card as never);
    tx.assignments.put(project as never, coder as never);
    // Each notification needs its own event: (event, recipient) is unique.
    for (let seq = 1; seq <= 6; seq += 1)
      tx.events.append(
        project as never,
        {
          id: `01J0000000000000000000000${seq}`,
          card_id: "C-1",
          seq,
          type: "comment_posted",
          actor: { kind: "human", project_id: project },
          payload: { body: "hi" },
          created_at: "2030-01-01T00:00:00.000Z",
        } as never,
      );
  });
}

let nextSeq = 1;
const note = (
  status: "pending" | "belled" | "needs_attention" | "delivery_failed",
  recipient: never = {
    kind: "assignment",
    assignment_id: coder.id,
  } as never,
) => {
  const seq = nextSeq++;
  const created = recordNotification(store.database, {
    project_id: project as never,
    event_id: `01J0000000000000000000000${seq}` as never,
    card_id: "C-1" as never,
    seq,
    kind: "comment",
    recipient,
    at: "2030-01-01T00:00:00.000Z",
  }).notification;
  if (status === "pending") return created;
  const event =
    status === "belled"
      ? "bell"
      : status === "delivery_failed"
        ? "deliver_failed"
        : "needs_attention";
  return moveNotification(store.database, {
    project_id: project as never,
    id: created.id,
    event,
    at: "2030-01-01T00:00:00.000Z",
  });
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-inbox-"));
  store = Store.open({ dataDir });
  output = [];
  io = {
    env: { CARDIGAN_CONFIG_DIR: dataDir, CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("read-only commands must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  seed();
  nextSeq = 1;
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const printed = () => output.join("\n");

test("inbox lists pending, belled and failed notifications grouped by recipient", () => {
  note("pending");
  note("belled");
  note("delivery_failed", { kind: "pm_ops" } as never);
  // Answered and escalated rows are not "to deliver".
  note("needs_attention");

  expect(inboxCommand([], io)).toBe(0);
  const text = printed();
  expect(text).toContain(`assignment:${coder.id}（2）`);
  expect(text).toContain("pm_ops（1）");
  expect(text).toContain("pending");
  expect(text).toContain("belled");
  expect(text).toContain("delivery_failed");
  expect(text).not.toContain("needs_attention");
});

test("inbox can be narrowed to one Assignment", () => {
  note("pending");
  note("pending", { kind: "pm_ops" } as never);

  expect(inboxCommand(["--assignment", coder.id], io)).toBe(0);
  expect(printed()).toContain(`assignment:${coder.id}`);
  expect(printed()).not.toContain("pm_ops");
});

test("inbox says so when nothing is waiting", () => {
  expect(inboxCommand([], io)).toBe(0);
  expect(printed()).toContain("收件箱是空的");
});

test("attention lists escalated notifications and lost Assignments", async () => {
  note("needs_attention");
  note("delivery_failed", { kind: "pm_ops" } as never);
  store.uow.run((tx) =>
    tx.assignments.put(
      project as never,
      { ...coder, id: "A-9", runtime_state: "lost" } as never,
    ),
  );

  expect(await attentionCommand([], io)).toBe(0);
  const text = printed();
  expect(text).toContain("升级通知（2）");
  expect(text).toContain("needs_attention");
  expect(text).toContain("delivery_failed");
  expect(text).toContain("失联 / 状态未知的 Assignment（1）");
  expect(text).toContain("A-9");
});

test("attention is quiet when everything is healthy", async () => {
  note("pending");
  expect(await attentionCommand([], io)).toBe(0);
  expect(printed()).toContain("没有需要关注的项");
});

test("an unknown flag is a usage error", () => {
  // `main` turns the CliError into exit code 2.
  expect(() => inboxCommand(["--nope", "x"], io)).toThrow(/不认识的参数/);
});

test("attention capacity waits show the shared tier order and readable reasons", async () => {
  store.uow.run((tx) => {
    tx.work_items.put(
      project as never,
      {
        id: "W-1",
        card_id: "C-1",
        kind: "produce",
        role_id: "coder",
        status: "in_progress",
        required: true,
        depends_on: [],
        completion_criteria: [],
      } as never,
    );
    tx.work_items.put(
      project as never,
      {
        id: "W-2",
        card_id: "C-1",
        kind: "verify",
        role_id: "reviewer",
        status: "ready",
        required: true,
        depends_on: [],
        completion_criteria: [],
      } as never,
    );
    tx.assignments.put(
      project as never,
      {
        ...coder,
        id: "A-2",
        work_item_id: "W-2",
        role_id: "reviewer",
      } as never,
    );
    for (const n of [1, 2])
      tx.runs.put(
        project as never,
        {
          id: `R-${n}`,
          assignment_id: `A-${n}`,
          trigger_event_id: `01J0000000000000000000000${n}`,
          kind: "initial",
          status: "queued",
          queue_reason: "concurrency_limit",
          role_version: 1,
          model: "test",
          agent_cli_version: "1",
          outcome: null,
          summary: "",
        } as never,
      );
  });
  expect(await attentionCommand(["--project", project], io)).toBe(0);
  const out = printed();
  expect(out).toContain("等待并发名额（2）");
  expect(out).toContain("第2档 · 验证");
  expect(out).toContain("第4档 · 新产出");
  expect(out.indexOf("R-2 A-2")).toBeLessThan(out.indexOf("R-1 A-1"));
  expect(out).toContain("前面还有 0 个");
  expect(out).toContain("前面还有 1 个");
});

test("attention shows compatible launch warnings without environment or argument values", async () => {
  writeFileSync(
    join(dataDir, "launch.yaml"),
    JSON.stringify({
      profiles: {
        fixture: {
          harness: "codex",
          config: { approval_policy: "synthetic-secret" },
        },
      },
    }),
  );
  expect(await attentionCommand([], io)).toBe(0);
  expect(output.join("\n")).toContain("启动配置告警（3）");
  expect(output.join("\n")).not.toContain("synthetic-secret");
});
