import type {
  Assignment,
  Attachment,
  Decision,
  ToolName,
} from "@cardigan/domain";
import { STANDING_ROLE_TOOLS } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  card_id,
  NOW,
  project_id,
  seedProject,
} from "./test-support.js";

const sha = "d".repeat(64);
const url = `https://dl.example.invalid/app/1.0.0-${sha.slice(0, 12)}/app.apk`;
const publish = {
  card_id,
  kind: "approve",
  category: "publish",
  question: "发布 1.0.0？",
  context: "测试包",
  options: [
    { key: "publish", description: `发布到 ${url}`, impact: "公开" },
    { key: "reject", description: "不发", impact: "无" },
  ],
  recommended: "publish",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  plain_summary: {
    changed: "发布测试包",
    impact: "公开下载",
    risk: "对外发布",
  },
  attachment_ids: ["attachment-1"],
};

let store: Store, server: RunningServer, office: Client, sequence: number;
const precheck = vi.fn(
  async (_project: string, _a: Attachment, _url: string) =>
    [] as readonly string[],
);
beforeEach(async () => {
  store = Store.open({ dbPath: ":memory:" });
  sequence = 0;
  precheck.mockReset();
  precheck.mockResolvedValue([]);
  const { timeline } = seedProject(store, {
    allowed_tools: STANDING_ROLE_TOOLS,
  });
  const pm: Assignment = {
    id: "A-2" as never,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "fixture-pm",
    created_at: NOW,
    standing_mode: "office",
  };
  store.uow.run((tx) => {
    tx.assignments.put(project_id, pm);
    tx.roles.put(project_id, {
      role_id: "pm",
      role_version: 1,
      allowed_tools: STANDING_ROLE_TOOLS,
      capabilities: [],
    });
    tx.attachments.put(project_id, {
      id: "attachment-1",
      kind: "evidence",
      card_id,
      sha256: sha,
      size: 8,
      mime: "application/vnd.android.package-archive",
      uploaded_by: "human",
      storage_path: "",
      attach_to: { kind: "timeline_entry", id: timeline[0]?.id ?? "" },
    } as Attachment);
  });
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    clock: { now: () => NOW },
    precheckPublication: precheck,
    log: () => undefined,
  });
  const issued = store.issueToken({
    id: pm.mcp_token_id,
    project_id,
    assignment_id: pm.id,
    role: {
      role_version: 1,
      allowed_tools: STANDING_ROLE_TOOLS as readonly ToolName[],
    },
  });
  office = new Client({ name: "publish-approval-test", version: "1" });
  await office.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
});
afterEach(async () => {
  await office.close();
  await server.close();
  store.close();
});

const call = (args: object, key = `request-${++sequence}`) =>
  office.callTool({
    name: "request_decision",
    arguments: { idempotency_key: key, ...args },
  });
const error = (r: Awaited<ReturnType<typeof call>>) =>
  (r.structuredContent as { error?: { code: string; message: string } })?.error;
const decisions = () =>
  store.uow.read((tx) => tx.decisions.list(project_id).length);
const operatorActions = () =>
  store.uow.read((tx) =>
    tx.human_actions
      .list(project_id)
      .filter((h) => h.executor === "operator" && h.status === "open"),
  );

test("C-754: a malformed publish approval is refused naming what is missing, before any host check", async () => {
  const r = await call({ ...publish, kind: "choose" });
  expect(error(r)?.code).toBe("validation_failed");
  expect(error(r)?.message).toContain("kind 须为 approve（当前为 choose）");
  expect(precheck).not.toHaveBeenCalled();
  expect(decisions()).toBe(0);
});

test("C-754: a failing host precheck raises nothing and tells the operator once", async () => {
  precheck.mockResolvedValue([
    "凭据文件：凭据文件须只有 1 个 profile（当前 6 个）",
    "APK 包名和版本：APK 包名与配置的 package_name 不符",
  ]);
  const key = "same-key";
  const first = await call(publish, key);
  expect(error(first)?.code).toBe("validation_failed");
  expect(error(first)?.message).toContain(
    "1) 凭据文件：凭据文件须只有 1 个 profile（当前 6 个）；2) APK 包名和版本",
  );
  expect(error(first)?.message).toContain("已交张良处理");
  expect(decisions()).toBe(0);
  expect(operatorActions()).toHaveLength(1);
  expect(operatorActions()[0]?.instructions).toContain("当前 6 个");
  // Retrying, even with the same key, checks again and adds no second item.
  expect(error(await call(publish, key))?.code).toBe("validation_failed");
  expect(precheck).toHaveBeenCalledTimes(2);
  expect(operatorActions()).toHaveLength(1);
  // Once the host is fixed the same request goes through.
  precheck.mockResolvedValue([]);
  const raised = await call(publish, key);
  expect(raised.isError).not.toBe(true);
  expect(decisions()).toBe(1);
});

test("C-754: a ready host raises the approval with its target derived from the attachment", async () => {
  const r = await call(publish);
  expect(r.isError, JSON.stringify(r.structuredContent)).not.toBe(true);
  const q = r.structuredContent as unknown as Decision;
  expect(q.kind === "approve" && q.target).toEqual({
    subject: { kind: "artifact_sha256", value: sha },
  });
  expect(precheck).toHaveBeenCalledWith(
    project_id,
    expect.objectContaining({ id: "attachment-1", sha256: sha }),
    url,
  );
});

test("C-754: other decisions never run the publish precheck", async () => {
  const r = await call({
    ...publish,
    kind: "choose",
    category: "general",
    attachment_ids: [],
  });
  expect(r.isError, JSON.stringify(r.structuredContent)).not.toBe(true);
  expect(precheck).not.toHaveBeenCalled();
});

test("C-754: request_decision documents the publish approval format", async () => {
  const tool = (await office.listTools()).tools.find(
    (t) => t.name === "request_decision",
  );
  expect(tool?.description).toContain("kind=approve");
  expect(tool?.description).toContain("发布到 <最终 HTTPS APK 地址>");
});
