import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  EXT_MESSAGE_DEFAULTS,
  extMessageItems,
  notices,
} from "@cardigan/domain";
import {
  loadCommandState,
  type RunningServer,
  startMcpServer,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assignment,
  card,
  project_id as p,
  workItem,
} from "../../store/src/test-support.js";
import { ExtMessageSender } from "./ext-message.js";
import { FeishuApp } from "./feishu-app.js";
import { enqueueOwnerMessage, ownerMessageText } from "./owner-message.js";

const sample = [
  "Android 0.4.3 测试版",
  "必须更新：否",
  "What\u0027s new",
  "修复离线启动。",
  "Download",
  "File: app-release.apk",
  "https://example.invalid/app.apk（18 MB）",
  `SHA-256：${"a".repeat(64)}`,
  "安装：下载后覆盖安装。",
  "iPhone：暂无测试版。",
  "Known issues",
  "弱网下首次加载较慢。",
].join("\n");
const scope = "test-app";
let dir: string,
  store: Store,
  server: RunningServer,
  sender: ExtMessageSender,
  now: number,
  token: string;
const remote = {
  text: vi.fn(async (_to: string, _uuid: string, _text: string) => true),
  create: vi.fn(),
  patch: vi.fn(),
  bindingFailure: vi.fn(),
};
function caller(overrides: Partial<Assignment> = {}) {
  const a = assignment({
    role_id: "pm",
    scope: "standing",
    standing_mode: "office",
    ...overrides,
  });
  return store.uow.run((tx) => {
    tx.assignments.put(p, a);
    // Deliberately over-scoped token, to exercise server authorization even for old tokens.
    return tx.issueToken({
      project_id: p,
      assignment_id: a.id,
      role: { role_version: 1, allowed_tools: ["send_owner_message"] },
    }).token;
  });
}
function prefer(on = true) {
  store.uow.run((tx) =>
    tx.project_preferences.put(p, {
      id: p,
      auto_merge_after_minutes: null,
      pm_owner_messages: on,
    }),
  );
}
const bind = () =>
  store.database
    .prepare(
      `INSERT OR REPLACE INTO feishu_bindings(scope,generation,member,open_id,chat,watermark) SELECT ?,?,id,'owner-private','dm',0 FROM members WHERE role='owner'`,
    )
    .run(scope, randomUUID());
const rpc = async (method: string, params: object) => {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).result;
};
const send = async (args: Record<string, unknown> = {}) =>
  (
    await rpc("tools/call", {
      name: "send_owner_message",
      arguments: {
        idempotency_key: randomUUID(),
        card_id: "C-1",
        text: sample,
        ...args,
      },
    })
  ).structuredContent;
const statuses = () =>
  store.database
    .prepare("SELECT status FROM owner_messages ORDER BY rowid")
    .all()
    .map((r) => r.status);
beforeEach(async () => {
  now = Date.parse("2026-01-01T23:59:00Z");
  remote.text.mockClear();
  dir = mkdtempSync(join(tmpdir(), "owner-message-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: p, name: "Fixture" });
  store.uow.run((tx) => {
    tx.cards.put(p, card());
    tx.work_items.put(p, workItem());
  });
  token = caller();
  store.database
    .prepare(
      `INSERT INTO feishu_runtime(id,scope,state,heartbeat) VALUES(1,?,'connected',?)`,
    )
    .run(scope, now);
  const app = new FeishuApp(
    store,
    scope,
    "https://wb.invalid",
    remote,
    undefined,
    () => now,
  );
  sender = new ExtMessageSender({
    store,
    clock: { now: () => new Date(now).toISOString() },
    startApplication: () => app,
    configuration: {
      status: "loaded",
      config: {
        enabled: true,
        channels: { lark_app: { enabled: true } },
        quiet_hours: { timezone: "UTC", start: "22:00", end: "07:00" },
        workbench_url: app.base,
        policy: EXT_MESSAGE_DEFAULTS,
      },
    },
  });
  sender.recordStatus();
  server = await startMcpServer({
    store,
    log: () => {},
    acknowledgeRuns: false,
    deliveryVerifier: () => {
      throw Error("unused");
    },
    enqueueOwnerMessage: (actor, input, current) =>
      enqueueOwnerMessage(store, actor, input, current, () => now),
  });
});
afterEach(async () => {
  await server?.close();
  await sender?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("release notes go from MCP to owner-only plain text after quiet hours, without a Needs You item", async () => {
  expect((await send()).error.message).toContain("未开启");
  prefer();
  expect((await send()).error.message).toBe("所有者尚未绑定飞书私聊");
  bind();
  const args = { idempotency_key: "release-0.4.3" },
    result = await send(args);
  expect(result.status).toBe("queued");
  expect(await send(args)).toEqual(result);
  expect((await send({ ...args, text: "different" })).error.code).toBe(
    "idempotency_conflict",
  );
  await sender.tick();
  expect(remote.text).not.toHaveBeenCalled();
  now = Date.parse("2026-01-02T07:00:00Z");
  await sender.tick();
  await sender.tick();
  expect(remote.text.mock.calls).toEqual([
    ["owner-private", result.message_id, `[FIX-C-1] ${sample}`],
  ]);
  expect(remote.create).not.toHaveBeenCalled();
  const s = store.uow.read((tx) => loadCommandState(tx, p));
  expect(extMessageItems(s, p)).toEqual([]);
  expect(notices(s)).toEqual([]);
  expect(s.decisions).toHaveLength(0);
  expect(s.human_actions).toHaveLength(0);
  const hash = createHash("sha256").update(sample).digest("hex");
  expect(s.timeline.map((e) => e.body)).toEqual([
    expect.stringContaining("已排队"),
    expect.stringContaining("已发送"),
  ]);
  for (const e of s.timeline) {
    expect(e.body).toContain(hash);
    expect(e.body).toContain("Android 0.4.3");
    expect(e.body).not.toContain("弱网");
  }
  expect(
    store.database.prepare("SELECT status,body FROM owner_messages").get(),
  ).toMatchObject({ status: "sent", body: null });
});

test.each([
  { scope: "work_item", role_id: "coder" },
  { scope: "work_item", role_id: "pm" },
  { standing_mode: "ops" },
  { external: true },
  { role_id: "host_ops" },
])(
  "refuses other callers even with the tool in their token: %o",
  async (overrides) => {
    token = caller({ id: "A-2", ...overrides });
    prefer();
    bind();
    expect((await rpc("tools/list", {})).tools).toEqual([]);
    expect((await send()).error.code).toBe("forbidden_tool");
    expect(statuses()).toEqual([]);
  },
);

test("rejects invalid content, recipient overrides, attachments and sensitive cards before admission", async () => {
  prefer();
  bind();
  for (const args of [
    { text: "X".repeat(4001) },
    { text: "@all" },
    { text: "客服：tel:+15550100000" },
    { attachment_id: "attachment-1" },
    { attachments: [] },
    { receive_id: "group" },
    { card_id: "C-999" },
  ])
    expect((await send(args)).error).toBeDefined();
  store.uow.run((tx) => tx.cards.put(p, card({ sensitive: true })));
  expect((await send()).error.message).toContain("敏感卡");
  expect(statuses()).toEqual([]);
});
test("the same release note is delivered with an HTTPS download and refused before admission with a blob address", async () => {
  prefer();
  bind();
  const note = (download: string) =>
    sample
      .replace("https://example.invalid/app.apk（18 MB）", download)
      .replace("SHA-256：", "SHA-256:");
  const blob = note(
    "blob:https://example.invalid/08a31081-73b5-4400-a25e-9190e9c40320",
  );
  expect((await send({ text: blob })).error.message).toBe(
    "正文链接仅支持 http 或 https",
  );
  expect(statuses()).toEqual([]);
  const https = note("Download:https://example.invalid/app.apk"),
    result = await send({ text: https });
  expect(result.status).toBe("queued");
  now += 8 * 3_600_000;
  await sender.tick();
  expect(remote.text.mock.calls).toEqual([
    ["owner-private", result.message_id, `[FIX-C-1] ${https}`],
  ]);
  expect(statuses()).toEqual(["sent"]);
});
test.each(["unbind", "rebind", "sensitive", "opt-out"])(
  "never dispatches queued text after %s",
  async (change) => {
    prefer();
    bind();
    expect((await send()).status).toBe("queued");
    if (change === "sensitive")
      store.uow.run((tx) => tx.cards.put(p, card({ sensitive: true })));
    else if (change === "opt-out") prefer(false);
    else if (change === "unbind")
      store.database.exec("DELETE FROM feishu_bindings");
    else bind();
    now += 8 * 3_600_000;
    await sender.tick();
    expect(statuses()).toEqual(["skipped"]);
    expect(remote.text).not.toHaveBeenCalled();
  },
);
test("rolling hourly quotas bound both admissions and quiet-hour backlog dispatch", async () => {
  prefer();
  bind();
  for (let i = 0; i < 6; i++) expect((await send()).status).toBe("queued");
  expect((await send()).error.message).toContain("最多 6 条");
  now += 3_600_000;
  expect((await send()).status).toBe("queued");
  now += 7 * 3_600_000;
  for (let i = 0; i < 7; i++) {
    await sender.tick();
    now += 60_000;
  }
  expect(remote.text).toHaveBeenCalledTimes(6);
  now += 3_600_000;
  await sender.tick();
  expect(remote.text).toHaveBeenCalledTimes(7);
});
test("lost response is audited as uncertain and never resent", async () => {
  prefer();
  bind();
  await send();
  now += 8 * 3_600_000;
  remote.text.mockRejectedValueOnce(new Error("private detail"));
  await sender.tick();
  await sender.tick();
  expect(statuses()).toEqual(["unknown"]);
  expect(remote.text).toHaveBeenCalledTimes(1);
});

test("a crash after the durable claim cannot cause a second dispatch", async () => {
  prefer();
  bind();
  await send();
  now += 8 * 3_600_000;
  store.database.exec(
    `CREATE TRIGGER lose_result BEFORE INSERT ON events WHEN NEW.type='owner_message_sent' BEGIN SELECT RAISE(ABORT, 'lost commit'); END`,
  );
  await expect(sender.tick()).rejects.toThrow("lost commit");
  expect(statuses()).toEqual(["sending"]);
  store.database.exec("DROP TRIGGER lose_result");
  now += EXT_MESSAGE_DEFAULTS.timeout_ms + 1;
  await sender.tick();
  expect(statuses()).toEqual(["unknown"]);
  expect(remote.text).toHaveBeenCalledTimes(1);
});

test("C-674: owner messages lead with the card's full number once", () => {
  expect(ownerMessageText("SEN", "C-34" as never, "发布了")).toBe(
    "[SEN-C-34] 发布了",
  );
  expect(ownerMessageText("SEN", "C-34" as never, "SEN-C-34 发布了")).toBe(
    "SEN-C-34 发布了",
  );
  expect(ownerMessageText(undefined, "C-34" as never, "发布了")).toBe(
    "[C-34] 发布了",
  );
});

test("C-676: short numbers in the owner's message body become full numbers", () => {
  expect(
    ownerMessageText("SEN", "C-34" as never, "C-35 依赖 C-34，拍板见 Q-7"),
  ).toBe("[SEN-C-34] SEN-C-35 依赖 SEN-C-34，拍板见 SEN-Q-7");
  // A body that starts with the card's short number is not prefixed twice.
  expect(ownerMessageText("SEN", "C-34" as never, "C-34 已发布")).toBe(
    "SEN-C-34 已发布",
  );
});
