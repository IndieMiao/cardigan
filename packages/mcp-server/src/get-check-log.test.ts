import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test, vi } from "vitest";
import { authenticate } from "./auth.js";
import type { McpBackend, McpReadContext } from "./backend.js";
import { memoryLogger } from "./log.js";
import { serverTools, startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  assignments,
  card_id,
  NOW,
  project_id,
  seedProject,
  serverCard,
  workItems,
} from "./test-support.js";
import { getCardTool } from "./tools/get-card.js";
import {
  CheckLogReadLimitError,
  getCheckLogTool,
} from "./tools/get-check-log.js";
import { visibleTools } from "./tools/types.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cg-check-log-"));
  roots.push(dir);
  const store = Store.open({ dataDir: dir });
  stores.push(store);
  seedProject(store, { allowed_tools: ["get_check_log", "get_card"] });
  store.uow.run((tx) => {
    tx.work_items.put(project_id, {
      ...workItems,
      assignment_id: assignments.id,
    });
    for (const [seq, type] of [
      [4, "merge_check_queued"],
      [5, "merge_check_finished"],
      [6, "precheck_finished"],
    ] as const) {
      tx.events.append(project_id, {
        id: `event-${seq}` as never,
        card_id,
        seq,
        type,
        actor: { kind: "system", project_id },
        created_at: NOW,
        payload: {
          attempt_id: seq === 6 ? "precheck-1" : "attempt-1",
          status: seq === 4 ? "queued" : "failed",
          log_ref: "/untrusted/ignored",
        },
      });
    }
  });
  const issued = store.issueToken({
    project_id,
    assignment_id: assignments.id,
    role: { role_version: 1, allowed_tools: ["get_check_log", "get_card"] },
  });
  const auth = authenticate(store, issued.token);
  if (!auth.ok) throw new Error("fixture authentication failed");
  const context = {
    store,
    identity: auth.value,
    revalidateToken: () => {
      if (!store.verifyToken(issued.token)) throw new Error("revoked");
    },
  };
  const reader = vi.fn(
    async ({ offset, limit }: { offset: number; limit: number }) => {
      const bytes = Buffer.from("abcdefghijklmnopqrst");
      return {
        text: bytes.subarray(offset, offset + limit).toString(),
        next_offset: Math.min(bytes.length, offset + limit),
        size: bytes.length,
      };
    },
  );
  const tool = getCheckLogTool({
    checkLogReader: reader,
    checkLogLimits: { per_read_bytes: 6, per_assignment_attempt_bytes: 10 },
  });
  const call = (args = {}) =>
    tool.handler(
      { card_id, attempt_id: "attempt-1", ...args },
      context,
    ) as Promise<Record<string, unknown>>;
  return { store, dir, context, reader, tool, call, issued };
}

test("registers a strict tool and exposes merge/precheck attempt IDs without trusting log_ref", async () => {
  const f = fixture();
  expect(
    serverTools({ deliveryVerifier: acceptingVerifierFor }).some(
      (t) => t.name === "get_check_log",
    ),
  ).toBe(true);
  expect(
    f.tool.input.safeParse({
      card_id,
      attempt_id: "attempt-1",
      path: "/secret",
    }).success,
  ).toBe(false);
  for (const args of [
    { attempt_id: "../other" },
    { offset: -1 },
    { offset: 0.5 },
    { limit: 0 },
  ])
    expect(
      f.tool.input.safeParse({ card_id, attempt_id: "attempt-1", ...args })
        .success,
    ).toBe(false);
  const card = (await getCardTool.handler({ card_id }, f.context)) as {
    card: { check_attempts: unknown[] };
  };
  expect(card.card.check_attempts).toEqual([
    { attempt_id: "attempt-1", kind: "merge", status: "failed" },
    { attempt_id: "precheck-1", kind: "precheck", status: "failed" },
  ]);
  expect(JSON.stringify(card)).not.toContain("/untrusted/ignored");
  expect(await f.call({ attempt_id: "precheck-1" })).toMatchObject({
    bytes: 6,
  });
});

test("caps each response and charges repeated offsets to the same persistent budget", async () => {
  const f = fixture();
  expect(await f.call({ limit: 100 })).toMatchObject({
    text: "abcdef",
    bytes: 6,
    remaining_bytes: 4,
    truncated: true,
    next_offset: 6,
  });
  expect(await f.call()).toMatchObject({
    text: "abcd",
    bytes: 4,
    remaining_bytes: 0,
    next_offset: 4,
  });
  await expect(f.call()).rejects.toThrow("额度已耗尽");
});

test("UTF-8 bytes, not characters or metadata, determine the debit", async () => {
  const f = fixture();
  f.reader.mockResolvedValue({ text: "甲乙", next_offset: 6, size: 9 });
  expect(await f.call()).toMatchObject({
    text: "甲乙",
    bytes: 6,
    remaining_bytes: 4,
  });
  expect(await f.call()).toMatchObject({
    text: "甲",
    bytes: 3,
    remaining_bytes: 1,
    next_offset: 3,
    truncated: true,
  });
});

test("concurrent reads cannot overspend after both asynchronous reads start", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.reader.mockImplementation(async () => {
    await gate;
    return { text: "abcdef", next_offset: 6, size: 20 };
  });
  const pending = [f.call(), f.call()];
  release();
  const pages = await Promise.all(pending);
  expect(pages.map((p) => p.bytes).sort()).toEqual([4, 6]);
  await expect(f.call()).rejects.toThrow("额度已耗尽");
});

test("budget survives a new Store connection and a different token/session", async () => {
  const f = fixture();
  await f.call();
  const other = Store.open({ dataDir: f.dir });
  stores.push(other);
  const token = other.issueToken({
    project_id,
    assignment_id: assignments.id,
    role: { role_version: 1, allowed_tools: ["get_check_log"] },
  });
  const auth = authenticate(other, token.token);
  if (!auth.ok) throw new Error("auth");
  // The first response can be lost; its committed debit still survives.
  expect(
    await f.tool.handler(
      { card_id, attempt_id: "attempt-1" },
      { store: other, identity: auth.value },
    ),
  ).toMatchObject({ bytes: 4, remaining_bytes: 0 });
});

test("a different authorized Assignment has an independent budget, including work-item PM acceptance", async () => {
  const f = fixture();
  await f.call();
  await f.call();
  const a: Assignment = {
    ...assignments,
    id: "A-2" as never,
    work_item_id: "W-2" as never,
    role_id: "pm",
  };
  f.store.uow.run((tx) => {
    tx.assignments.put(project_id, a);
    tx.work_items.put(project_id, {
      ...workItems,
      id: "W-2" as never,
      kind: "verify",
      status: "todo",
      max_review_rounds: 3,
      role_id: "pm",
      assignment_id: a.id,
    });
  });
  const token = f.store.issueToken({
    project_id,
    assignment_id: a.id,
    role: { role_version: 1, allowed_tools: ["get_check_log"] },
  });
  const auth = authenticate(f.store, token.token);
  if (!auth.ok) throw new Error("auth");
  expect(
    await f.tool.handler(
      { card_id, attempt_id: "attempt-1" },
      { store: f.store, identity: auth.value },
    ),
  ).toMatchObject({ bytes: 6, remaining_bytes: 4 });
});

test.each([
  "foreign_card",
  "foreign_project",
  "unknown_attempt",
  "released",
  "suspended",
  "standing_office",
  "standing_ops",
  "host_ops",
  "replaced",
  "wrong_kind",
])("rejects %s before filesystem IO", async (kind) => {
  const f = fixture();
  let args = {};
  if (kind === "foreign_card") {
    f.store.uow.run((tx) =>
      tx.cards.put(project_id, { ...serverCard, id: "C-2" as never }),
    );
    args = { card_id: "C-2" };
  } else if (kind === "unknown_attempt") args = { attempt_id: "not-this-card" };
  else if (kind === "foreign_project")
    f.context.identity = {
      ...f.context.identity,
      actor: { ...f.context.identity.actor, project_id: "other" as never },
    };
  else
    f.store.uow.run((tx) => {
      if (kind === "replaced")
        tx.work_items.put(project_id, {
          ...workItems,
          assignment_id: "A-other" as never,
        });
      else if (kind === "wrong_kind")
        tx.work_items.put(project_id, {
          ...workItems,
          kind: "standing",
          assignment_id: assignments.id,
        } as never);
      else
        tx.assignments.put(
          project_id,
          kind.startsWith("standing")
            ? ({
                ...assignments,
                scope: "standing",
                role_id: "pm",
                standing_mode: kind === "standing_ops" ? "ops" : "office",
              } as Assignment)
            : {
                ...assignments,
                ...(["released", "suspended"].includes(kind)
                  ? { status: kind as "released" | "suspended" }
                  : { role_id: "host_ops" }),
              },
        );
    });
  await expect(f.call(args)).rejects.toThrow();
  expect(f.reader).not.toHaveBeenCalled();
  expect(
    f.store.database.prepare("SELECT * FROM check_log_debits").all(),
  ).toEqual([]);
});

test.each(["release", "replace", "revoke"])(
  "rechecks %s after asynchronous IO without charging or returning text",
  async (change) => {
    const f = fixture();
    f.reader.mockImplementation(async () => {
      if (change === "revoke") f.store.revokeToken(f.issued.record.id);
      else
        f.store.uow.run((tx) => {
          if (change === "release")
            tx.assignments.put(project_id, {
              ...assignments,
              status: "released",
            });
          else
            tx.work_items.put(project_id, {
              ...workItems,
              assignment_id: "A-other" as never,
            });
        });
      return { text: "secret-free", next_offset: 11, size: 11 };
    });
    await expect(f.call()).rejects.toThrow();
    expect(
      f.store.database.prepare("SELECT * FROM check_log_debits").all(),
    ).toEqual([]);
  },
);

test("missing/unsafe files produce a path-free error without charging", async () => {
  const f = fixture();
  f.reader.mockRejectedValue(new Error("ENOENT /private/host/log/secret"));
  await expect(f.call()).rejects.toThrow("检查日志不存在");
  try {
    await f.call();
  } catch (error) {
    expect(String(error)).not.toContain("/private");
  }
  expect(
    f.store.database.prepare("SELECT * FROM check_log_debits").all(),
  ).toEqual([]);
});

test("standing callers cannot list/guess the tool, even with an overbroad token", () => {
  const f = fixture();
  for (const role_id of ["pm", "host_ops"])
    for (const standing_mode of ["office", "ops"])
      expect(
        visibleTools([f.tool], ["get_check_log"], {
          role_id,
          scope: "standing",
          standing_mode,
        }),
      ).toEqual([]);
});

test("real MCP endpoint enforces registration, strict arguments and token revocation", async () => {
  const f = fixture();
  const server = await startMcpServer({
    store: f.store,
    deliveryVerifier: acceptingVerifierFor,
    port: 0,
    acknowledgeRuns: false,
    checkLogReader: f.reader,
    log: memoryLogger().log,
  });
  const client = new Client({ name: "check-log-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${f.issued.token}` } },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "get_check_log",
    );
    expect(
      (
        await client.callTool({
          name: "get_check_log",
          arguments: { card_id, attempt_id: "attempt-1", path: "/private" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "get_check_log",
          arguments: { card_id, attempt_id: "attempt-1" },
        })
      ).isError,
    ).not.toBe(true);
    f.store.revokeToken(f.issued.record.id);
    await expect(
      client.callTool({
        name: "get_check_log",
        arguments: { card_id, attempt_id: "attempt-1" },
      }),
    ).rejects.toThrow();
  } finally {
    await client.close();
    await server.close();
  }
});

test("approved defaults enforce 64 KiB per call and 1 MiB per Assignment/attempt", async () => {
  const f = fixture();
  f.reader.mockResolvedValue({
    text: "a".repeat(80 * 1024),
    next_offset: 80 * 1024,
    size: 80 * 1024,
  });
  const tool = getCheckLogTool({ checkLogReader: f.reader });
  const call = () =>
    tool.handler({ card_id, attempt_id: "attempt-1" }, f.context) as Promise<{
      bytes: number;
      remaining_bytes: number;
    }>;
  for (let i = 0; i < 16; i++) {
    const page = await call();
    expect(page.bytes).toBe(65536);
    expect(page.remaining_bytes).toBe(1048576 - (i + 1) * 65536);
  }
  await expect(call()).rejects.toThrow("额度已耗尽");
});

test.each(["office", "ops"] as const)(
  "authentication strips the log tool from standing PM %s and prevents enumeration",
  async (standing_mode) => {
    const f = fixture();
    f.store.uow.run((tx) =>
      tx.assignments.put(project_id, {
        ...assignments,
        scope: "standing",
        role_id: "pm",
        standing_mode,
      } as Assignment),
    );
    const auth = authenticate(f.store, f.issued.token);
    if (!auth.ok) throw new Error("auth");
    expect(auth.value.actor.allowed_tools).not.toContain("get_check_log");
    const card = (await getCardTool.handler(
      { card_id },
      { ...f.context, identity: auth.value },
    )) as { card: { check_attempts: unknown[] } };
    expect(card.card.check_attempts).toEqual([]);
  },
);

test("a positive remainder that cannot fit the next UTF-8 character fails without another debit", async () => {
  const f = fixture();
  f.reader.mockResolvedValue({ text: "甲乙", next_offset: 6, size: 6 });
  const tool = getCheckLogTool({
    checkLogReader: f.reader,
    checkLogLimits: { per_read_bytes: 6, per_assignment_attempt_bytes: 4 },
  });
  expect(
    await tool.handler({ card_id, attempt_id: "attempt-1" }, f.context),
  ).toMatchObject({ text: "甲", bytes: 3, next_offset: 3, remaining_bytes: 1 });
  f.reader.mockResolvedValue({ text: "乙", next_offset: 6, size: 6 });
  for (let i = 0; i < 2; i++)
    await expect(
      tool.handler({ card_id, attempt_id: "attempt-1", offset: 3 }, f.context),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { reason: "attempt_budget_too_small", remaining_bytes: 1 },
    });
  expect(
    f.store.database.prepare("SELECT bytes FROM check_log_debits").all(),
  ).toEqual([{ bytes: 3 }]);
});

test("reader limit refusal remains distinct from missing files and never debits", async () => {
  const f = fixture();
  f.reader.mockRejectedValue(new CheckLogReadLimitError());
  await expect(f.call({ limit: 1 })).rejects.toMatchObject({
    code: "validation_failed",
    details: { reason: "read_limit_too_small" },
  });
  expect(
    f.store.database.prepare("SELECT * FROM check_log_debits").all(),
  ).toEqual([]);
});

test.each(["assignments", "events"] as const)(
  "get_card reports a safe explicit failure for %s faults instead of an empty attempt list",
  async (repository) => {
    const f = fixture();
    const backend = Object.create(f.store) as McpBackend;
    Object.defineProperty(backend, "uow", {
      value: {
        ...f.store.uow,
        read: <T>(operation: (tx: McpReadContext) => T): T =>
          f.store.uow.read((tx) =>
            operation({
              ...tx,
              [repository]: {
                ...tx[repository],
                ...(repository === "assignments"
                  ? {
                      get: () => {
                        throw new Error(
                          "synthetic repository failure /private/secret",
                        );
                      },
                    }
                  : {
                      listAfter: () => {
                        throw new Error(
                          "synthetic decode failure /private/secret",
                        );
                      },
                    }),
              },
            }),
          ),
      },
    });
    // Both repositories succeed on earlier get_card reads; only attempt discovery
    // calls assignments.get or events.listAfter in this fixture with no completion.
    await expect(
      Promise.resolve().then(() =>
        getCardTool.handler({ card_id }, { ...f.context, store: backend }),
      ),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: "检查日志列表读取失败。",
    });
  },
);

test.each(["get_card", "get_check_log"])(
  "independent review: %s rejects a token revoked while its HTTP body is pending",
  async (name) => {
    const { request } = await import("node:http");
    const f = fixture();
    const server = await startMcpServer({
      store: f.store,
      deliveryVerifier: acceptingVerifierFor,
      port: 0,
      acknowledgeRuns: false,
      checkLogReader: f.reader,
      log: memoryLogger().log,
    });
    const originalVerify = f.store.verifyToken.bind(f.store);
    let authenticated!: () => void;
    const checked = new Promise<void>((resolve) => {
      authenticated = resolve;
    });
    const spy = vi.spyOn(f.store, "verifyToken").mockImplementation((token) => {
      const record = originalVerify(token);
      if (record) authenticated();
      return record;
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments:
          name === "get_card"
            ? { card_id }
            : { card_id, attempt_id: "attempt-1" },
      },
    });
    let req!: ReturnType<typeof request>;
    const response = new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        req = request(
          server.url,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${f.issued.token}`,
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: text }),
            );
          },
        );
        req.on("error", reject);
        req.flushHeaders();
      },
    );
    try {
      await checked;
      f.store.revokeToken(f.issued.record.id);
      expect(originalVerify(f.issued.token)).toBeUndefined();
      f.store.uow.run((tx) =>
        tx.events.append(project_id, {
          id: "event-after-revocation" as never,
          card_id,
          seq: 7,
          type: "precheck_finished",
          actor: { kind: "system", project_id },
          created_at: NOW,
          payload: { attempt_id: "created-after-revocation", status: "failed" },
        }),
      );
      req.end(body);
      const result = await response;
      expect(result.status).toBe(200);
      const payload = JSON.parse(result.body).result;
      expect(payload.isError).toBe(true);
      expect(f.reader).not.toHaveBeenCalled();
      expect(result.body).not.toContain("created-after-revocation");
      const attempts = payload.structuredContent?.card?.check_attempts ?? [];
      expect({ rejected: payload.isError === true, attempts }).toSatisfy(
        (value: { rejected: boolean; attempts: unknown[] }) =>
          value.rejected || value.attempts.length === 0,
      );
    } finally {
      req.destroy();
      spy.mockRestore();
      await server.close();
    }
  },
);
