import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXT_MESSAGE_DEFAULTS,
  type ExtMessage,
  type ExtMessagePort,
  extMessageItems,
  type HumanAction,
  notices,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  claimExtMessage,
  listExtMessages,
  projectExtMessage,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { card, project_id } from "../../store/src/test-support.js";
import { ExtMessageSender, sendExtMessage } from "./ext-message.js";
import type { ExtMessageConfig } from "./ext-message-config.js";

let dir: string;
let store: Store;
let now: string;
let config: ExtMessageConfig;
const action: HumanAction = {
  id: "H-1",
  key: "H-1",
  card_id: "C-1",
  requested_by: "human",
  instructions: "PRIVATE body",
  why_human: "PRIVATE reason",
  expected_return: "PRIVATE expected",
  blocked_work_items: [],
  status: "open",
};
class FakeAdapter implements ExtMessagePort {
  messages: ExtMessage[] = [];
  result: "sent" | "retryable" | "permanent" = "sent";
  async send(message: ExtMessage) {
    this.messages.push(message);
    return this.result;
  }
}
let fake: FakeAdapter;
const clock = { now: () => now };
const sender = (
  overrides: Partial<ConstructorParameters<typeof ExtMessageSender>[0]> = {},
) =>
  new ExtMessageSender({
    store,
    configuration: { status: "loaded", config },
    clock,
    adapters: { fake: () => fake },
    ...overrides,
  });
const rows = () => listExtMessages(store.database);
const events = () =>
  store.uow.read((tx) => loadCommandState(tx, project_id).events);
const advance = (ms: number) => {
  now = new Date(Date.parse(now) + ms).toISOString();
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ext-sender-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: project_id, name: "Fictional" });
  now = "2026-01-01T00:00:00.000Z";
  config = {
    enabled: true,
    workbench_url: "https://workbench.invalid",
    policy: EXT_MESSAGE_DEFAULTS,
    channels: { fake: { enabled: true, credential: "SYNTHETIC_SECRET" } },
  };
  fake = new FakeAdapter();
  store.uow.run((tx) => {
    tx.cards.put(project_id, card());
    tx.human_actions.put(project_id, action);
    tx.events.append(project_id, {
      id: tx.ids.nextEventId(),
      card_id: "C-1",
      seq: tx.ids.nextEventSequence(project_id, "C-1"),
      type: "human_action_requested",
      actor: { kind: "human", project_id },
      payload: { human_action_id: "H-1" },
      created_at: now,
    });
  });
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test("success is audited, deduplicated across restart, and disabled config leaves no outbox", async () => {
  await sender({ configuration: { status: "missing" } }).tick();
  await sender({ configuration: { status: "invalid" } }).tick();
  await sender({
    configuration: { status: "loaded", config: { ...config, enabled: false } },
  }).tick();
  expect(rows()).toEqual([]);
  const first = sender();
  first.recordStatus();
  await first.tick();
  expect(rows()).toMatchObject([{ status: "sent", attempts: 1 }]);
  expect(events().filter((e) => e.type === "ext_message_sent")).toHaveLength(1);
  store.close();
  store = Store.open({ dataDir: dir });
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  const persisted = JSON.stringify([
    rows(),
    events(),
    store.database.prepare("SELECT doc FROM ext_message_host_status").all(),
  ]);
  expect(persisted).not.toContain("SYNTHETIC_SECRET");
  expect(persisted).not.toContain("https://");
  expect(persisted).not.toContain("PRIVATE");
});
test("retry at 30 and 60 seconds, three attempts total, one final notice with no recursion", async () => {
  fake.result = "retryable";
  await sender().tick();
  expect(rows()).toMatchObject([
    {
      status: "pending",
      attempts: 1,
      next_attempt_at: "2026-01-01T00:00:30.000Z",
    },
  ]);
  advance(29999);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  advance(1);
  await sender().tick();
  expect(rows()[0]?.attempts).toBe(2);
  advance(59999);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(1);
  await sender().tick();
  expect(rows()).toMatchObject([{ status: "failed", attempts: 3 }]);
  advance(60000);
  await sender().tick();
  expect(fake.messages).toHaveLength(3);
  expect(
    store.uow.read((tx) => notices(loadCommandState(tx, project_id))),
  ).toHaveLength(1);
  expect(events().filter((e) => e.type === "ext_message_failed")).toHaveLength(
    3,
  );
});
test("permanent errors stop immediately; raw thrown errors are reduced to unknown", async () => {
  fake.result = "permanent";
  await sender().tick();
  advance(100000);
  await sender().tick();
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 1, last_error: "permanent" },
  ]);
  expect(
    await sendExtMessage(
      {
        send: async () => {
          throw new Error("https://secret.invalid/webhook SYNTHETIC_SECRET");
        },
      },
      { title: "test", url: "https://workbench.invalid" },
      100,
    ),
  ).toBe("unknown");
});
test("processed or missing items skip without sending, and sensitivity is read at dispatch", async () => {
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, { ...action, status: "done" }),
  );
  await sender().tick();
  expect(rows()).toMatchObject([{ status: "skipped", attempts: 0 }]);
  expect(fake.messages).toEqual([]);
  expect(events().filter((e) => e.type === "ext_message_skipped")).toHaveLength(
    1,
  );
});
test("sensitive item reaches adapter with only generic prompt and link", async () => {
  store.uow.run((tx) => tx.cards.put(project_id, card({ sensitive: true })));
  await sender().tick();
  expect(fake.messages[0]).toEqual({
    title: "有 1 条敏感事项待处理",
    url: "https://workbench.invalid/#/p/p-fictional/cards/C-1?at=human-action-H-1",
  });
});
test("crash after reserving an attempt consumes its budget and waits before recovery", async () => {
  store.uow.run((tx) => {
    const item = extMessageItems(
      loadCommandState(tx, project_id),
      project_id,
    )[0]!;
    projectExtMessage(store.database, item, "fake", now);
    claimExtMessage(
      store.database,
      rows()[0]!,
      "crashed",
      now,
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:40.000Z",
    );
  });
  store.close();
  store = Store.open({ dataDir: dir });
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  advance(39999);
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  advance(1);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  expect(rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
});
test("third crashed attempt finalizes once with a Workbench notice", async () => {
  store.uow.run((tx) =>
    projectExtMessage(
      store.database,
      extMessageItems(loadCommandState(tx, project_id), project_id)[0]!,
      "fake",
      now,
    ),
  );
  store.database
    .prepare(
      "UPDATE ext_message_outbox SET attempts=3, lease_id='crashed', lease_until=?, next_attempt_at=?",
    )
    .run(now, now);
  await sender().tick();
  await sender().tick();
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 3, last_error: "unknown" },
  ]);
  expect(fake.messages).toHaveLength(0);
  expect(events().filter((e) => e.type === "ext_message_failed")).toHaveLength(
    1,
  );
});
test("timeout aborts, another channel succeeds independently, concurrent senders do not claim twice", async () => {
  vi.useFakeTimers();
  let aborted = false;
  const slow: ExtMessagePort = {
    send: (_m, signal) =>
      new Promise(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      }),
  };
  config = {
    ...config,
    channels: { ...config.channels, second: { enabled: true } },
  };
  const options = { adapters: { fake: () => slow, second: () => fake } };
  const a = sender(options).tick();
  await vi.advanceTimersByTimeAsync(0);
  const b = sender(options).tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.messages).toHaveLength(1);
  expect(rows().find((r) => r.channel === "fake")?.attempts).toBe(1);
  advance(10000);
  await vi.advanceTimersByTimeAsync(10000);
  await Promise.all([a, b]);
  expect(aborted).toBe(true);
  expect(rows().find((r) => r.channel === "fake")).toMatchObject({
    status: "pending",
    attempts: 1,
    last_error: "timeout",
  });
});
test("deferred and quiet items wait, then handled items skip; absent adapter fails safely", async () => {
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, {
      ...action,
      ready_when: { kind: "manual" },
    }),
  );
  await sender().tick();
  expect(fake.messages).toEqual([]);
  store.uow.run((tx) => tx.human_actions.put(project_id, action));
  config = {
    ...config,
    quiet_hours: { timezone: "UTC", start: "23:00", end: "08:00" },
  };
  await sender().tick();
  expect(rows()[0]?.attempts).toBe(0);
  advance(8 * 3600000);
  await sender({ adapters: {} }).tick();
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 1, last_error: "adapter_unavailable" },
  ]);
});

test("remote success followed by local commit failure rolls back audit and recovers within the same budget", async () => {
  store.database.exec(
    `CREATE TRIGGER fail_sent BEFORE INSERT ON events WHEN NEW.type = 'ext_message_sent' BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END`,
  );
  await expect(sender().tick()).rejects.toThrow("simulated commit failure");
  expect(fake.messages).toHaveLength(1);
  expect(rows()).toMatchObject([{ status: "pending", attempts: 1 }]);
  expect(events().some((e) => e.type === "ext_message_sent")).toBe(false);
  store.database.exec("DROP TRIGGER fail_sent");
  advance(40000);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  expect(rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
  expect(events().filter((e) => e.type === "ext_message_sent")).toHaveLength(1);
  expect(events().filter((e) => e.type === "ext_message_failed")).toHaveLength(
    1,
  );
});

test("late result cannot overwrite the successor's result after a lease expires", async () => {
  let resolve: (result: "sent") => void = () => {};
  const old = sender({
    adapters: {
      fake: () => ({
        send: () =>
          new Promise<"sent">((done) => {
            resolve = done;
          }),
      }),
    },
  }).tick();
  await Promise.resolve();
  advance(40000);
  fake.result = "permanent";
  await sender().tick();
  resolve("sent");
  await old;
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 2, last_error: "permanent" },
  ]);
  expect(events().filter((e) => e.type === "ext_message_sent")).toEqual([]);
});
