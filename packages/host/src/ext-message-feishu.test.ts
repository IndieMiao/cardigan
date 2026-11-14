import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExtMessage,
  EXT_MESSAGE_DEFAULTS,
  type ExtMessageItem,
  type HumanAction,
} from "@cardigan/domain";
import { listExtMessages, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { card, project_id } from "../../store/src/test-support.js";
import {
  ExtMessageSender,
  extMessageAdapters,
  sendExtMessage,
} from "./ext-message.js";
import { createFeishuAdapter } from "./ext-message-feishu.js";

const webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-only";
const credential = JSON.stringify({
  webhook,
  secret: "SYNTHETIC_SIGNING_SECRET",
});
const item: ExtMessageItem = {
  project_id: "fictional",
  card_id: "C-1",
  event_id: "event-1",
  item_id: "Q-1",
  kind: "decision",
  title: "请确认😀",
  sensitive: false,
  handled: false,
  ready: true,
};
const message = () => buildExtMessage(item, "https://workbench.invalid");
let server: Server;
let endpoint: string;
let payloads: Array<Record<string, unknown>>;
let handle: (response: ServerResponse) => void;
let received: ReturnType<typeof Promise.withResolvers<void>>;
let localFetch: typeof fetch;
beforeEach(async () => {
  payloads = [];
  received = Promise.withResolvers<void>();
  handle = (response) =>
    response.writeHead(200).end('{"code":0,"msg":"success"}');
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
    received.resolve();
    handle(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  endpoint = `http://127.0.0.1:${address.port}/hook`;
  localFetch = async (input, init) => {
    // Production still receives only the configured HTTPS URL. All test IO stays on loopback.
    expect(String(input)).toBe(webhook);
    expect(init?.redirect).toBe("manual");
    return fetch(endpoint, init);
  };
});
afterEach(async () => {
  vi.useRealTimers();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});
const adapter = (signed = true) =>
  createFeishuAdapter(signed ? credential : JSON.stringify({ webhook }), {
    fetch: localFetch,
    now: () => 1767225600000,
  });

test("post protocol sends separate clickable links and the independently calculated signing vector", async () => {
  expect(extMessageAdapters.lark).toBe(createFeishuAdapter);
  expect(await sendExtMessage(adapter(), message(), 10000)).toBe("sent");
  expect(payloads).toEqual([
    {
      msg_type: "post",
      timestamp: "1767225600",
      sign: "4Hl5ItT0EESm861/o/WCsPoVFUYTkWVfMB8ceTf6SIo=",
      content: {
        post: {
          zh_cn: {
            content: [
              [
                {
                  tag: "text",
                  text: "[Cardigan] fictional C-1 拍板：请确认😀",
                  un_escape: false,
                },
              ],
              [
                {
                  tag: "a",
                  text: "打开工作台",
                  href: "https://workbench.invalid/#/p/fictional/cards/C-1?at=decision-Q-1",
                },
              ],
            ],
          },
        },
      },
    },
  ]);
  expect(JSON.stringify(payloads)).not.toContain("SYNTHETIC_SIGNING_SECRET");
  expect(JSON.stringify(payloads)).not.toContain(webhook);
});

test("sensitive content is generic; unsigned mode and untrusted title text cannot create mentions", async () => {
  await sendExtMessage(
    adapter(false),
    buildExtMessage(
      { ...item, sensitive: true, title: "PRIVATE" },
      "https://workbench.invalid",
    ),
    10000,
  );
  expect(payloads[0]).not.toHaveProperty("sign");
  expect(JSON.stringify(payloads[0])).toContain(
    "[Cardigan] fictional 有 1 条敏感事项待处理",
  );
  expect(JSON.stringify(payloads[0])).not.toContain("PRIVATE");
  await sendExtMessage(
    adapter(),
    buildExtMessage(
      {
        ...item,
        title:
          '<at user_id="all">所有人</at> & <a href="https://evil.invalid">x</a>',
      },
      "https://workbench.invalid",
    ),
    10000,
  );
  expect(JSON.stringify(payloads[1])).not.toContain('"tag":"at"');
  expect(JSON.stringify(payloads[1])).toContain("&lt;at");
  expect(JSON.stringify(payloads[1])).not.toContain("<at");
});

test.each([
  [200, '{"code":0}', "sent"],
  [200, '{"code":11232,"msg":"SYNTHETIC_SECRET"}', "retryable"],
  [200, '{"code":99991400}', "retryable"],
  [200, '{"code":99991500}', "retryable"],
  [200, '{"code":19021,"msg":"SYNTHETIC_SECRET"}', "permanent"],
  [200, '{"code":19024}', "permanent"],
  [200, '{"code":19001}', "permanent"],
  [200, '{"code":"0"}', "retryable"],
  [200, "not json SYNTHETIC_SECRET", "retryable"],
  [200, "x".repeat(20000), "retryable"],
  [400, "SYNTHETIC_SECRET", "permanent"],
  [403, "SYNTHETIC_SECRET", "permanent"],
  [408, "SYNTHETIC_SECRET", "retryable"],
  [429, "SYNTHETIC_SECRET", "retryable"],
  [503, "SYNTHETIC_SECRET", "retryable"],
] as const)(
  "HTTP %s and business response are classified without returning bodies (%#)",
  async (status, body, expected) => {
    handle = (response) => response.writeHead(status).end(body);
    expect(await sendExtMessage(adapter(), message(), 10000)).toBe(expected);
    expect(payloads).toHaveLength(1);
  },
);

test("redirect never follows a second target, and pre-aborted calls do no IO", async () => {
  handle = (response) =>
    response.writeHead(307, { location: `${endpoint}/forbidden` }).end();
  expect(await sendExtMessage(adapter(), message(), 10000)).toBe("permanent");
  expect(payloads).toHaveLength(1);
  const abort = new AbortController();
  abort.abort();
  expect(await adapter().send(message(), abort.signal)).toBe("retryable");
  expect(payloads).toHaveLength(1);
});

test("HTTP timeout aborts the request at the approved ten seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  handle = () => {};
  const result = sendExtMessage(
    adapter(),
    message(),
    EXT_MESSAGE_DEFAULTS.timeout_ms,
  );
  await received.promise;
  await vi.advanceTimersByTimeAsync(9999);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe("timeout");
  expect(payloads).toHaveLength(1);
});

test("real HTTP digest retries once per attempt and reprojects handled/sensitive state after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-digest-"));
  let store = Store.open({ dataDir: dir });
  let now = "2026-01-01T15:00:00.000Z"; // 23:00 in Shanghai
  const action: HumanAction = {
    id: "H-1",
    key: "H-1",
    card_id: "C-1",
    requested_by: "human",
    instructions: "PRIVATE instructions",
    why_human: "PRIVATE reason",
    expected_return: "PRIVATE expected",
    blocked_work_items: [],
    status: "open",
  };
  const config = {
    enabled: true,
    workbench_url: "https://workbench.invalid",
    policy: EXT_MESSAGE_DEFAULTS,
    channels: { lark: { enabled: true, credential } },
    quiet_hours: { timezone: "Asia/Shanghai", start: "22:00", end: "08:00" },
  };
  const sender = () =>
    new ExtMessageSender({
      store,
      configuration: { status: "loaded", config },
      clock: { now: () => now },
      adapters: { lark: () => adapter() },
    });
  try {
    store.createProject({ id: project_id, name: "Fictional" });
    store.uow.run((tx) => {
      tx.cards.put(project_id, card());
      for (let n = 1; n <= 22; n++) {
        const id = `H-${n}` as HumanAction["id"];
        tx.human_actions.put(project_id, { ...action, id, key: id });
        tx.events.append(project_id, {
          id: tx.ids.nextEventId(),
          card_id: "C-1",
          seq: tx.ids.nextEventSequence(project_id, "C-1"),
          type: "human_action_requested",
          actor: { kind: "human", project_id },
          payload: { human_action_id: id },
          created_at: now,
        });
      }
    });
    await sender().tick();
    expect(payloads).toHaveLength(0);
    store.close();
    store = Store.open({ dataDir: dir });
    now = "2026-01-02T00:00:00.000Z";
    handle = (response) => response.writeHead(200).end('{"code":11232}');
    await sender().tick();
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads[0])).toContain("免打扰期间 22 条待处理");
    store.uow.run((tx) => {
      tx.human_actions.put(project_id, { ...action, status: "done" });
      tx.cards.put(project_id, card({ sensitive: true }));
    });
    now = "2026-01-02T00:00:29.999Z";
    await sender().tick();
    expect(payloads).toHaveLength(1);
    now = "2026-01-02T00:00:30.000Z";
    handle = (response) => response.writeHead(200).end('{"code":0}');
    await sender().tick();
    expect(payloads).toHaveLength(2);
    expect(JSON.stringify(payloads[1])).toContain("免打扰期间 21 条待处理");
    expect(JSON.stringify(payloads[1]).match(/human-action-H-/gu)).toHaveLength(
      20,
    );
    expect(JSON.stringify(payloads[1])).toContain("/needs-you");
    expect(JSON.stringify(payloads[1])).toContain("有 1 条敏感事项待处理");
    expect(JSON.stringify(payloads[1])).not.toContain("PRIVATE");
    expect(JSON.stringify(payloads[1])).not.toContain('human-action-H-1"');
    expect(
      listExtMessages(store.database).filter((r) => r.status === "sent"),
    ).toHaveLength(21);
    await sender().tick();
    expect(payloads).toHaveLength(2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
