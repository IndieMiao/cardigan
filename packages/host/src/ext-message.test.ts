import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Decision,
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
import {
  type ExtMessageConfig,
  loadExtMessageConfig,
} from "./ext-message-config.js";

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
  store.uow.run((tx) => tx.cards.put(project_id, card()));
});
// Mature-channel tests publish their first fact *after* activation.
const startChannel = () => {
  sender().recordStatus();
  addAction(1);
};

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
  addAction(1);
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
  startChannel();
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
  startChannel();
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
test("first enable ignores handled history, but audits an already queued item that was handled", async () => {
  startChannel();
  const [prior] = store.uow.read((tx) =>
    extMessageItems(loadCommandState(tx, project_id), project_id),
  );
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, { ...action, status: "done" }),
  );
  await sender().tick();
  expect(rows()).toEqual([]);
  expect(events().some((e) => e.type === "ext_message_skipped")).toBe(false);
  projectExtMessage(store.database, prior!, "fake", now);
  await sender().tick();
  expect(rows()).toMatchObject([{ status: "skipped", attempts: 0 }]);
  expect(fake.messages).toEqual([]);
  expect(events().filter((e) => e.type === "ext_message_skipped")).toHaveLength(
    1,
  );
});
test("sensitive item reaches adapter with only project, generic prompt and link", async () => {
  startChannel();
  store.uow.run((tx) => tx.cards.put(project_id, card({ sensitive: true })));
  await sender().tick();
  expect(fake.messages[0]).toEqual({
    project: project_id,
    title: "有 1 条敏感事项待处理",
    url: "https://workbench.invalid/#/p/p-fictional/cards/C-1?at=human-action-H-1",
  });
});
test("crash after reserving an attempt consumes its budget and waits before recovery", async () => {
  startChannel();
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
  startChannel();
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
  startChannel();
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
  config = {
    ...config,
    quiet_hours: { timezone: "UTC", start: "23:00", end: "08:00" },
  };
  startChannel();
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, {
      ...action,
      ready_when: { kind: "manual" },
    }),
  );
  await sender().tick();
  expect(fake.messages).toEqual([]);
  store.uow.run((tx) => tx.human_actions.put(project_id, action));
  await sender().tick();
  expect(rows()[0]?.attempts).toBe(0);
  advance(8 * 3600000);
  await sender({ adapters: {} }).tick();
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 1, last_error: "adapter_unavailable" },
  ]);
});

test("remote success followed by local commit failure rolls back audit and recovers within the same budget", async () => {
  startChannel();
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
  startChannel();
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

test.each(["sent", "commit_failure", "timeout"] as const)(
  "shutdown drains the second channel (%s) after the first channel cannot commit",
  async (outcome) => {
    vi.useFakeTimers();
    config = {
      ...config,
      channels: { first: { enabled: true }, second: { enabled: true } },
    };
    startChannel();
    store.database.exec(`CREATE TRIGGER fail_channel_sent BEFORE INSERT ON events
      WHEN NEW.type = 'ext_message_sent' AND json_extract(NEW.doc, '$.payload.channel') = 'first'
      BEGIN SELECT RAISE(ABORT, 'first result commit failure'); END`);
    if (outcome === "commit_failure")
      store.database.exec(`CREATE TRIGGER fail_second_sent BEFORE INSERT ON events
        WHEN NEW.type = 'ext_message_sent' AND json_extract(NEW.doc, '$.payload.channel') = 'second'
        BEGIN SELECT RAISE(ABORT, 'second result commit failure'); END`);
    const second = Promise.withResolvers<"sent">();
    const active = sender({
      adapters: {
        first: () => fake,
        second: () => ({ send: () => second.promise }),
      },
    });
    let tickSettled = false;
    let stopSettled = false;
    const tickResult = active
      .tick()
      .catch((error: unknown) => error)
      .finally(() => {
        tickSettled = true;
      });
    let stopResult: Promise<unknown> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(rows()).toMatchObject([
        { channel: "first", status: "pending", attempts: 1 },
        { channel: "second", status: "pending", attempts: 1 },
      ]);
      expect(fake.messages).toHaveLength(1);
      expect(tickSettled).toBe(false);
      stopResult = active
        .stop()
        .catch((error: unknown) => error)
        .finally(() => {
          stopSettled = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopSettled).toBe(false);
      if (outcome === "timeout") {
        advance(10000);
        await vi.advanceTimersByTimeAsync(10000);
      } else {
        second.resolve("sent");
      }
      const [tickError, stopError] = await Promise.all([
        tickResult,
        stopResult,
      ]);
      expect(tickSettled).toBe(true);
      expect(stopSettled).toBe(true);
      expect(stopError).toBe(tickError);
      if (outcome === "commit_failure") {
        expect(tickError).toBeInstanceOf(AggregateError);
        expect(
          (tickError as AggregateError).errors.map((e: Error) => e.message),
        ).toEqual([
          "first result commit failure",
          "second result commit failure",
        ]);
      } else {
        expect(tickError).toMatchObject({
          message: "first result commit failure",
        });
      }
      const secondRow = rows().find((r) => r.channel === "second");
      expect(secondRow).toMatchObject(
        outcome === "sent"
          ? { status: "sent", attempts: 1 }
          : {
              status: "pending",
              attempts: 1,
              last_error: outcome === "timeout" ? "timeout" : null,
            },
      );
      expect(
        events().filter((e) => e.type === "ext_message_sent"),
      ).toHaveLength(outcome === "sent" ? 1 : 0);
      // The caller can now close its Store. A fresh process sees every completed result.
      store.close();
      store = Store.open({ dataDir: dir });
      expect(rows().find((r) => r.channel === "second")).toEqual(secondRow);
    } finally {
      second.resolve("sent");
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([tickResult, stopResult]);
    }
  },
);

const quiet = () => {
  config = {
    ...config,
    quiet_hours: { timezone: "UTC", start: "23:00", end: "08:00" },
  };
};
const addAction = (n: number, project: string = project_id) =>
  store.uow.run((tx) => {
    const id = `H-${n}` as HumanAction["id"];
    tx.human_actions.put(project, { ...action, id, key: id });
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      card_id: "C-1",
      seq: tx.ids.nextEventSequence(project, "C-1"),
      type: "human_action_requested",
      actor: { kind: "human", project_id: project },
      payload: { human_action_id: id },
      created_at: now,
    });
  });

test("first enable excludes 700 unread notices and 200 open actions, including queued/failed history", async () => {
  for (let n = 1; n <= 200; n++) addAction(n);
  store.uow.run((tx) => {
    for (let i = 0; i < 700; i++)
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project_id),
        type: "host_role_upgraded",
        actor: { kind: "system", project_id },
        created_at: now,
        payload: {},
      });
    const history = extMessageItems(
      loadCommandState(tx, project_id),
      project_id,
    );
    expect(
      history.filter((i) => i.kind === "notice" && !i.handled),
    ).toHaveLength(700);
    expect(
      history.filter((i) => i.kind === "human_action" && i.ready && !i.handled),
    ).toHaveLength(200);
    for (const item of history.slice(0, 2))
      projectExtMessage(store.database, item, "fake", now);
    store.database
      .prepare(
        "UPDATE ext_message_outbox SET status='failed',attempts=3,last_error='retryable' WHERE item_id=?",
      )
      .run(history[0]!.item_id);
  });
  const active = sender();
  active.recordStatus();
  await active.tick();
  expect(fake.messages).toEqual([]);
  expect(rows().map((r) => r.status)).toEqual(["skipped", "skipped"]);
  expect(
    events().filter((e) => e.type === "ext_message_history_invalidated"),
  ).toMatchObject([{ payload: { channel: "fake", count: 2 } }]);
  addAction(201); // Same wall-clock instant, later commit.
  await sender().tick();
  await sender().tick();
  expect(fake.messages).toMatchObject([{ item: "H-201" }]);
  const state = store.uow.read((tx) => loadCommandState(tx, project_id));
  expect(notices(state).filter((n) => !n.read)).toHaveLength(700);
  expect(state.human_actions.filter((h) => h.status === "open")).toHaveLength(
    201,
  );
});

test.each([
  "total switch",
  "channel switch",
  "credential change",
  "policy change",
])("%s starts a new epoch and fences the old sender", async (change) => {
  const old = sender();
  old.recordStatus();
  addAction(1);
  fake.result = "retryable";
  await old.tick();
  expect(rows()).toMatchObject([{ status: "pending", attempts: 1 }]);
  if (change.endsWith("switch")) {
    const disabled =
      change === "total switch"
        ? { ...config, enabled: false }
        : { ...config, channels: { fake: { enabled: false } } };
    sender({
      configuration: { status: "loaded", config: disabled },
    }).recordStatus();
  } else if (change === "credential change")
    config = {
      ...config,
      channels: {
        fake: { enabled: true, credential: "SYNTHETIC_REPLACEMENT" },
      },
    };
  else config = { ...config, policy: { ...config.policy, max_per_minute: 2 } };
  addAction(2);
  advance(60_000);
  const active = sender();
  active.recordStatus();
  addAction(3);
  fake.result = "sent";
  await old.tick();
  expect(fake.messages).toHaveLength(1);
  await active.tick();
  expect(rows()).toMatchObject([
    { item_id: "H-1", status: "skipped", attempts: 1 },
    { item_id: "H-3", status: "sent" },
  ]);
  expect(fake.messages.map((m) => "item" in m && m.item)).toEqual([
    "H-1",
    "H-3",
  ]);
});

test.each([11, 80])(
  "recovering quota does not split a partially projected burst (%i initially)",
  async (initial) => {
    const total = initial === 11 ? 50 : 80;
    const active = sender();
    active.recordStatus();
    for (let n = 1; n <= initial; n++) addAction(n);
    await active.tick();
    advance(1000);
    for (let n = initial + 1; n <= total; n++) addAction(n);
    expect(fake.messages).toHaveLength(10);
    store.close();
    store = Store.open({ dataDir: dir });
    advance(59_000);
    await sender().tick();
    expect(fake.messages).toHaveLength(10);
    await sender().tick();
    advance(60_000);
    await sender().tick();
    expect(fake.messages.slice(10)).toEqual([
      { title: `${total - 10} 条待处理`, url: config.workbench_url },
    ]);
    expect(rows().filter((r) => r.status === "sent")).toHaveLength(total);
  },
);

test.each([false, true])(
  "a cross-project summary waits for a fresh membership snapshot (one handled: %s)",
  async (handled) => {
    const b = "project-b";
    store.createProject({ id: b, name: "B" });
    store.uow.run((tx) => tx.cards.put(b, card()));
    const active = sender();
    active.recordStatus();
    for (let n = 1; n <= 11; n++) addAction(n);
    await active.tick();
    advance(1000);
    for (let n = 12; n <= 20; n++) addAction(n);
    for (let n = 21; n <= 50; n++) addAction(n, b);
    advance(59_000);
    const other = Store.open({ dataDir: dir });
    try {
      let conflicted = false;
      store.observe({
        transaction(kind) {
          if (
            kind !== "run" ||
            rows().filter((r) => r.project_id === b).length !== 30
          )
            return;
          store.observe(undefined);
          conflicted = true;
          other.uow.run((tx) => {
            if (handled)
              tx.human_actions.put(b, {
                ...action,
                id: "H-21",
                key: "H-21",
                status: "done",
              });
            tx.events.append(b, {
              id: tx.ids.nextEventId(),
              seq: tx.ids.nextEventSequence(b),
              type: "run_started",
              actor: { kind: "system", project_id: b },
              created_at: now,
              payload: {},
            });
          });
        },
      });
      await sender().tick();
      expect(conflicted).toBe(true);
      expect(fake.messages).toHaveLength(10);
      await sender().tick();
      advance(60_000);
      await sender().tick();
      expect(fake.messages.slice(10)).toEqual([
        { title: `${handled ? 39 : 40} 条待处理`, url: config.workbench_url },
      ]);
      expect(rows().find((r) => r.item_id === "H-21")?.status).toBe(
        handled ? "skipped" : "sent",
      );
    } finally {
      other.close();
    }
  },
);

test.each([
  [10, 0],
  [32, 0],
  [10, 10],
] as const)(
  "the final slot persists overflow not yet projected (limit %i, %i slots already used)",
  async (limit, used) => {
    config = { ...config, policy: { ...config.policy, max_per_minute: limit } };
    const active = sender();
    active.recordStatus();
    if (used) {
      for (let n = 1; n <= used; n++) addAction(100 + n);
      await active.tick();
    }
    for (let n = 1; n <= 32 - limit + used; n++) {
      addAction(n);
      const id = `H-${n}` as const;
      store.uow.run((tx) =>
        tx.human_actions.put(project_id, {
          ...action,
          id,
          key: id,
          ready_when: { kind: "manual" },
        }),
      );
    }
    store.uow.run((tx) => {
      for (let n = 1; n <= 50; n++)
        tx.events.append(project_id, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project_id),
          type: "host_role_upgraded",
          actor: { kind: "system", project_id },
          created_at: now,
          payload: {},
        });
    });
    await active.tick();
    expect(rows()).toHaveLength(32 + used);
    expect(fake.messages).toHaveLength(limit);
    store.close();
    store = Store.open({ dataDir: dir });
    advance(60_000);
    const restarted = sender();
    await restarted.tick();
    await restarted.tick();
    advance(60_000);
    await restarted.tick();
    expect(fake.messages.slice(limit)).toEqual([
      { title: `${50 - limit + used} 条待处理`, url: config.workbench_url },
    ]);
  },
);

test("a claimed retry revoked by a new recipient is never dispatched to the old one", async () => {
  const other = Store.open({ dataDir: dir });
  try {
    const targets: string[] = [];
    const boot = (target: string, db: Store) =>
      sender({
        store: db,
        configuration: {
          status: "loaded",
          config: {
            ...config,
            channels: {
              lark: {
                enabled: true,
                credential: JSON.stringify({
                  webhook: `https://open.feishu.cn/open-apis/bot/v2/hook/${target}`,
                }),
              },
            },
          },
        },
        adapters: {
          lark: () => ({
            async send() {
              targets.push(target);
              return targets.length === 1 ? "retryable" : "sent";
            },
          }),
        },
      });
    const a = boot("A", store),
      b = boot("B", other);
    a.recordStatus();
    addAction(1);
    await a.tick();
    advance(30_000);
    afterClaim(() => {
      expect(rows()[0]).toMatchObject({ status: "pending", attempts: 2 });
      b.recordStatus();
      expect(rows()[0]).toMatchObject({ status: "skipped", lease_id: null });
    });
    await a.tick();
    expect(targets).toEqual(["A"]);
    expect(rows()[0]).toMatchObject({ status: "skipped", lease_id: null });
    expect(events().filter((e) => e.type === "ext_message_sent")).toHaveLength(
      0,
    );
    expect(
      events().filter((e) => e.type === "ext_message_history_invalidated"),
    ).toHaveLength(1);
    addAction(2);
    await b.tick();
    expect(targets).toEqual(["A", "B"]);
  } finally {
    other.close();
  }
});

test("later arrivals and restarts cannot starve a partial rate summary", async () => {
  const active = sender();
  active.recordStatus();
  for (let n = 1; n <= 80; n++) addAction(n);
  await active.tick();
  advance(60_000);
  await active.tick();
  expect(fake.messages).toHaveLength(10);
  for (let n = 81; n <= 120; n++) addAction(n);
  store.close();
  store = Store.open({ dataDir: dir });
  await sender().tick();
  expect(fake.messages.slice(10)).toEqual([
    { title: "70 条待处理", url: config.workbench_url },
  ]);
  expect(rows().filter((r) => r.status === "sent")).toHaveLength(80);
  await sender().tick();
  expect(fake.messages).toHaveLength(20);
});

test("reformatting a loaded webhook credential preserves retry and offline work but rotation does not", async () => {
  const path = join(dir, "sender.yaml"),
    secret = join(dir, "sender.json");
  const webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/fixture";
  writeFileSync(
    path,
    `enabled: true\nworkbench_url: ${config.workbench_url}\nchannels: { lark: { enabled: true, credential_file: sender.json } }`,
    { mode: 0o600 },
  );
  writeFileSync(secret, JSON.stringify({ webhook, secret: "fixture" }), {
    mode: 0o600,
  });
  const start = () =>
    sender({
      configuration: loadExtMessageConfig(path),
      adapters: { lark: () => fake },
    });
  const initial = start();
  initial.recordStatus();
  addAction(1);
  fake.result = "retryable";
  await initial.tick();
  addAction(2);
  store.close();
  store = Store.open({ dataDir: dir });
  advance(30_000);
  writeFileSync(
    secret,
    JSON.stringify({ secret: "fixture", ignored: true, webhook }, null, 2),
  );
  fake.result = "sent";
  await start().tick();
  expect(rows()).toMatchObject([
    { item_id: "H-1", status: "sent", attempts: 2 },
    { item_id: "H-2", status: "sent", attempts: 1 },
  ]);
  addAction(3);
  writeFileSync(secret, JSON.stringify({ webhook, secret: "rotated" }));
  await start().tick();
  expect(fake.messages).toHaveLength(3);
  addAction(4);
  await start().tick();
  expect(fake.messages.at(-1)).toMatchObject({ item: "H-4" });
});

// Inject elapsed time between the durable claim and the synchronous adapter invocation.
const afterClaim = (f: () => void) =>
  store.observe({
    transaction(kind) {
      if (kind === "run" && rows().some((r) => r.lease_id)) {
        store.observe(undefined);
        f();
      }
    },
  });
test("a delayed dispatch occupies a rolling slot through the actual adapter call", async () => {
  config = { ...config, policy: { ...config.policy, max_per_minute: 1 } };
  startChannel();
  const sentAt: number[] = [];
  const start = () =>
    sender({
      adapters: {
        fake: () => ({
          async send() {
            sentAt.push(Date.parse(now));
            return "sent";
          },
        }),
      },
    });
  afterClaim(() => advance(100));
  await start().tick();
  addAction(2);
  store.close();
  store = Store.open({ dataDir: dir });
  advance(59_900);
  await start().tick();
  expect(sentAt).toHaveLength(1);
  advance(100);
  await start().tick();
  expect(sentAt[1]! - sentAt[0]!).toBe(60_000);
});

test("an unknown dispatch after a crash holds its slot through the last possible call plus 60s", async () => {
  config = {
    ...config,
    policy: { ...config.policy, max_per_minute: 1, timeout_ms: 120_000 },
  };
  startChannel();
  afterClaim(() => {
    throw new Error("crash after claim");
  });
  await expect(sender().tick()).rejects.toThrow("crash after claim");
  addAction(2);
  store.close();
  store = Store.open({ dataDir: dir });
  advance(60_000);
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  advance(119_999);
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  advance(1);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
});

test("a paused sender drops an expired unsent lease instead of sending outside its reservation", async () => {
  config = { ...config, policy: { ...config.policy, max_per_minute: 1 } };
  startChannel();
  afterClaim(() => advance(70_000));
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  expect(rows()).toMatchObject([
    { attempts: 0, status: "pending", lease_id: null },
  ]);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
});

const addTitledAction = (n: number) => {
  addAction(n);
  const id = `H-${n}` as const;
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, {
      ...action,
      id,
      key: id,
      handoff: {
        title: `Fixture ${n}`,
        summary: "",
        instructions: "",
        why_human: "",
        expected_outcome: "",
        expected_return: "",
        rewritten_by: "human",
        rewritten_at: now,
      },
    }),
  );
};

const summaryOf = (count: number) => ({
  title: `${count} 条待处理`,
  url: config.workbench_url,
});
const matrixTime = (ms: number) =>
  new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const matrixEntry = (n: number) => ({
  project: project_id,
  card: "C-1",
  item: `H-${n}`,
  kind: "human_action",
  title: `Fixture ${n}`,
  url: `${config.workbench_url}/#/p/${project_id}/cards/C-1?at=human-action-H-${n}`,
});
// Return a release function so the source time stays distinct from its readiness.
function holdMatrixAction(n: number) {
  addTitledAction(n);
  const id = `H-${n}` as const;
  return store.uow.run((tx) => {
    const held = tx.human_actions.get(project_id, id)!;
    tx.human_actions.put(project_id, {
      ...held,
      ready_when: { kind: "manual" },
    });
    return () =>
      store.uow.run((writer) => writer.human_actions.put(project_id, held));
  });
}

// Quiet creation must produce the same count-only deliveries,
// whether a bounded projection materialized the tail or the sender restarted.
const wakeCases = (["A", "B", "C"] as const).flatMap((scenario) =>
  [false, true].flatMap((extraScan) =>
    [false, true].map((restart) => ({ scenario, extraScan, restart })),
  ),
);
test.each(wakeCases)(
  "wake evidence $scenario extraScan=$extraScan restart=$restart",
  async ({ scenario, extraScan, restart }) => {
    config = {
      ...config,
      quiet_hours: { timezone: "UTC", start: "00:02", end: "00:03" },
      policy: { ...config.policy, max_per_minute: 1 },
    };
    const calls: {
      at: string;
      target: string | undefined;
      message: ExtMessage;
    }[] = [];
    const start = () =>
      sender({
        adapters: {
          fake: (target) => ({
            async send(message) {
              calls.push({ at: now, target, message });
              return "sent";
            },
          }),
        },
      });
    let active = start();
    active.recordStatus();
    now = matrixTime(scenario === "B" ? 121_000 : 130_000);
    const release: (() => void)[] = [];
    if (scenario === "C") {
      addTitledAction(101);
      addTitledAction(102);
      if (extraScan) await active.tick();
      expect(rows()).toHaveLength(extraScan ? 2 : 0);
    } else {
      for (let n = 101; n <= 134; n++) release.push(holdMatrixAction(n));
      await active.tick();
      if (extraScan) await active.tick();
      expect(rows()).toHaveLength(extraScan ? 34 : 32);
    }
    expect(calls).toEqual([]);
    if (restart) {
      await active.stop();
      store.close();
      store = Store.open({ dataDir: dir });
      active = start();
    }
    const wake = scenario === "B" ? 181_000 : 180_000;
    now = matrixTime(wake);
    for (const unlock of release.slice(scenario === "B" ? 32 : 0)) unlock();
    const target = config.channels.fake!.credential;
    await active.tick();
    const expected = [
      { at: now, target, message: summaryOf(scenario === "A" ? 34 : 2) },
    ];
    expect(calls).toEqual(expected);
    for (let i = 0; i < 4; i++) {
      advance(60_000);
      await active.tick();
    }
    expect(calls).toEqual(expected);
  },
);

test.each([false, true])(
  "a missed manual release is dated by its fact even after an unready scan: duringQuiet=%s",
  async (duringQuiet) => {
    config = {
      ...config,
      quiet_hours: { timezone: "UTC", start: "00:02", end: "00:03" },
    };
    const active = sender();
    active.recordStatus();
    now = matrixTime(119_000);
    holdMatrixAction(101);
    await active.tick();
    expect(fake.messages).toEqual([]);
    await active.stop();
    store.close();
    store = Store.open({ dataDir: dir });
    now = matrixTime(duringQuiet ? 179_999 : 180_000);
    store.uow.run((tx) =>
      tx.human_actions.put(project_id, {
        ...tx.human_actions.get(project_id, "H-101")!,
        ready_released: { at: now, by: "human", reason: "fixture" },
      }),
    );
    now = matrixTime(180_000);
    await sender().tick();
    expect(fake.messages).toEqual([
      duringQuiet ? summaryOf(1) : matrixEntry(101),
    ]);
  },
);

test.each(["enqueue", "retry", "route", "dispatch"] as const)(
  "a quiet %s cannot recover details after restart",
  async (edge) => {
    config = {
      ...config,
      quiet_hours: { timezone: "UTC", start: "00:02", end: "00:03" },
    };
    const active = sender();
    active.recordStatus();
    now = matrixTime(119_999);
    addTitledAction(1);
    if (edge === "retry") {
      fake.result = "retryable";
      await active.tick();
      expect(fake.messages).toEqual([matrixEntry(1)]);
      fake.messages = [];
      fake.result = "sent";
      advance(1);
      await active.tick();
    } else if (edge === "dispatch") {
      afterClaim(() => advance(1));
      await active.tick();
      expect(rows()).toMatchObject([{ status: "pending", attempts: 0 }]);
    } else if (edge === "route") {
      advance(1);
      store.uow.run((tx) =>
        tx.events.append(project_id, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project_id),
          type: "human_action_requested",
          actor: { kind: "system", project_id },
          created_at: now,
          payload: { human_action_id: "H-1" },
        }),
      );
    } else {
      let read = false;
      store.observe({
        transaction(kind) {
          if (kind === "read") {
            read = true;
            advance(1);
          } else if (read) {
            store.observe(undefined);
            void active.stop();
          }
        },
      });
      await active.tick();
      expect(rows()).toMatchObject([{ status: "pending" }]);
    }
    expect(fake.messages).toEqual([]);
    await active.stop();
    store.close();
    store = Store.open({ dataDir: dir });
    now = matrixTime(180_000);
    await sender().tick();
    advance(60_000);
    await sender().tick();
    expect(fake.messages).toEqual([summaryOf(1)]);
  },
);

test.each([1, 2])(
  "an ordinary arrival at wake stays outside the sealed two-item batch (limit %i)",
  async (limit) => {
    config = {
      ...config,
      quiet_hours: { timezone: "UTC", start: "00:02", end: "00:03" },
      policy: { ...config.policy, max_per_minute: limit },
    };
    const active = sender();
    active.recordStatus();
    now = matrixTime(60_000);
    for (let i = 1; i <= limit + 2; i++) addTitledAction(i);
    await active.tick();
    now = matrixTime(120_000);
    await active.tick();
    expect(fake.messages).toHaveLength(limit);
    now = matrixTime(180_000);
    addTitledAction(90);
    await active.tick();
    await active.tick();
    const count = (n: number) => ({
      title: `${n} 条待处理`,
      url: config.workbench_url,
    });
    expect(fake.messages.slice(limit)).toEqual(
      limit === 1 ? [count(2)] : [count(2), matrixEntry(90)],
    );
    for (let n = 0; n < 2; n++) {
      advance(60_000);
      await active.tick();
    }
    expect(fake.messages.slice(limit)).toEqual([
      count(2),
      limit === 1 ? count(1) : matrixEntry(90),
    ]);
  },
);

test("two connections contend for the last slot with a retry, frozen summary and ordinary item", async () => {
  config = {
    ...config,
    quiet_hours: { timezone: "UTC", start: "23:00", end: "23:01" },
    policy: { ...config.policy, max_per_minute: 2 },
  };
  const otherProject = "project-b";
  store.createProject({ id: otherProject, name: "Other" });
  store.uow.run((tx) => tx.cards.put(otherProject, card()));
  const active = sender();
  active.recordStatus();
  addTitledAction(1);
  await active.tick();
  now = matrixTime(1000);
  for (let i = 2; i <= 4; i++) addTitledAction(i);
  fake.result = "retryable";
  await active.tick();
  // Hold the failed single until the already-open summary has itself tried once.
  const h2 = store.uow.read((tx) => tx.human_actions.get(project_id, "H-2")!);
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, { ...h2, ready_when: { kind: "manual" } }),
  );
  now = matrixTime(60_000);
  await active.tick();
  expect(fake.messages).toHaveLength(3);
  const count = (n: number) => ({
    title: `${n} 条待处理`,
    url: config.workbench_url,
  });
  expect(fake.messages[2]).toEqual(count(2));
  now = matrixTime(90_000);
  store.uow.run((tx) => tx.human_actions.put(project_id, h2));
  addAction(5, otherProject);
  const other = Store.open({ dataDir: dir });
  const gate = Promise.withResolvers<"sent">();
  const calls: { at: number; message: ExtMessage }[] = [];
  const run = (db: Store) =>
    sender({
      store: db,
      adapters: {
        fake: (target) => ({
          async send(message) {
            expect(target).toBe("SYNTHETIC_SECRET");
            calls.push({ at: Date.parse(now), message });
            return calls.length === 1 ? gate.promise : "sent";
          },
        }),
      },
    }).tick();
  try {
    const first = run(store);
    try {
      await run(other);
      expect(calls).toHaveLength(1);
    } finally {
      gate.resolve("sent");
      await first;
    }
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      advance(60_000);
      await run(other);
      await run(store);
    }
    expect(calls.map((c) => c.message)).toHaveLength(3);
    expect(calls.map((c) => c.message)).toContainEqual(matrixEntry(2));
    expect(calls.map((c) => c.message)).toContainEqual(count(2));
    const fifth = rows().find((r) => r.item_id === "H-5");
    expect(calls.map((c) => c.message)).toContainEqual(
      fifth?.digest_id?.startsWith("rate:")
        ? count(1)
        : {
            ...matrixEntry(5),
            project: otherProject,
            title: "有新的待你执行事项",
            url: `${config.workbench_url}/#/p/${otherProject}/cards/C-1?at=human-action-H-5`,
          },
    );
    expect(fifth).toMatchObject({
      project_id: otherProject,
      status: "sent",
      attempts: 1,
    });
    const times = [0, 1000, 60_000]
      .map((t) => Date.parse(matrixTime(t)))
      .concat(calls.map((c) => c.at));
    for (const t of times)
      expect(
        times.filter((at) => at > t - 60_000 && at <= t).length,
      ).toBeLessThanOrEqual(2);
  } finally {
    other.close();
  }
});

test.each(
  [10, 32].flatMap((limit) =>
    ["after projection", "before projection", "mixed quiet items"].map(
      (edge) => ({ limit, edge }),
    ),
  ),
)(
  "count-only ownership survives quiet hours: $edge, limit $limit",
  async ({ limit, edge }) => {
    config = {
      ...config,
      policy: { ...config.policy, max_per_minute: limit },
      quiet_hours: { timezone: "UTC", start: "00:02", end: "00:03" },
    };
    now = "2026-01-01T00:00:59.999Z";
    const first = sender();
    first.recordStatus();
    for (let n = 1; n <= 50; n++) addTitledAction(n);
    await first.tick();
    expect(fake.messages).toHaveLength(limit);
    expect(rows()).toHaveLength(32);
    store.close();
    store = Store.open({ dataDir: dir });
    advance(60_000);
    if (edge === "after projection") {
      store.observe({
        transaction(kind) {
          if (kind === "run" && rows().length === 50) {
            store.observe(undefined);
            advance(1);
          }
        },
      });
    } else advance(1);
    if (edge === "mixed quiet items") addTitledAction(51);
    await sender().tick();
    expect(now).toBe("2026-01-01T00:02:00.000Z");
    store.close();
    store = Store.open({ dataDir: dir });
    await sender().tick();
    expect(fake.messages).toHaveLength(limit);
    advance(60_000);
    const awake = sender();
    await awake.tick();
    const summary = {
      title: `${50 - limit} 条待处理`,
      url: config.workbench_url,
    };
    const delivered = fake.messages.slice(limit);
    if (edge === "mixed quiet items") {
      expect(delivered).toHaveLength(2);
      expect(delivered).toContainEqual(summary);
      expect(delivered).toContainEqual(summaryOf(1));
    } else expect(delivered).toEqual([summary]);
    advance(60_000);
    await awake.tick();
    expect(fake.messages.slice(limit)).toEqual(delivered);
  },
);

test.each(
  [1, 2].flatMap((limit) =>
    ["during quiet", "wake after read", "restart after projection"].map(
      (edge) => ({ limit, edge }),
    ),
  ),
)(
  "an older source released during quiet hours sends no details: $edge, limit $limit",
  async ({ limit, edge }) => {
    config = {
      ...config,
      policy: { ...config.policy, max_per_minute: limit },
      quiet_hours: { timezone: "UTC", start: "00:02", end: "00:03" },
    };
    const active = sender();
    active.recordStatus();
    addAction(90);
    const held = { ...action, id: "H-90", key: "H-90" } as const;
    store.uow.run((tx) =>
      tx.human_actions.put(project_id, {
        ...held,
        ready_when: { kind: "manual" },
      }),
    );
    await active.tick();
    expect(fake.messages).toHaveLength(0);
    for (let n = 1; n <= limit + 2; n++) addTitledAction(n);
    await active.tick();
    expect(fake.messages).toHaveLength(limit);
    advance(179_999);
    store.uow.run((tx) => tx.human_actions.put(project_id, held));
    if (edge === "during quiet") {
      await active.tick();
      expect(fake.messages).toHaveLength(limit);
      advance(1);
    } else {
      let sawRead = false;
      store.observe({
        transaction(kind) {
          if (kind === "read" && !sawRead) {
            sawRead = true;
            advance(1);
          } else if (
            kind === "run" &&
            sawRead &&
            edge === "restart after projection"
          ) {
            store.observe(undefined);
            void active.stop();
          }
        },
      });
      await active.tick();
      expect(sawRead).toBe(true);
      store.observe(undefined);
      if (edge === "restart after projection") {
        expect(fake.messages).toHaveLength(limit);
        expect(rows().find((r) => r.item_id === "H-90")).toMatchObject({
          status: "pending",
          digest_id: "queued",
          attempts: 0,
        });
        store.close();
        store = Store.open({ dataDir: dir });
      }
    }
    await sender().tick();
    advance(60_000);
    await sender().tick();
    advance(60_000);
    await sender().tick();
    expect(fake.messages.slice(limit)).toHaveLength(2);
    expect(fake.messages.slice(limit)).toContainEqual({
      title: "2 条待处理",
      url: config.workbench_url,
    });
    expect(fake.messages.slice(limit)).toContainEqual(summaryOf(1));
  },
);

test.each(["claim", "dispatch"])(
  "entering quiet hours at %s preserves the overflow without spending a slot",
  async (edge) => {
    config = {
      ...config,
      policy: { ...config.policy, max_per_minute: 1 },
      quiet_hours: { timezone: "UTC", start: "00:02", end: "00:03" },
    };
    startChannel();
    addAction(2);
    addAction(3);
    await sender().tick();
    advance(119_999);
    const claims = () =>
      store.database
        .prepare("SELECT COUNT(*) AS n FROM ext_message_attempts WHERE at>=?")
        .get(Date.parse(now) - 5)?.n;
    if (edge === "dispatch") afterClaim(() => advance(1));
    // Move time only when the claim samples the clock under the writer lock.
    let enterQuietOnClaim = false;
    const active = sender({
      clock: {
        now: () => {
          if (
            enterQuietOnClaim &&
            store.database.isTransaction &&
            store.database
              .prepare(
                "SELECT 1 FROM ext_message_rate_batches WHERE through IS NOT NULL",
              )
              .get()
          ) {
            enterQuietOnClaim = false;
            advance(1);
          }
          return now;
        },
      },
    });
    active.recordStatus();
    enterQuietOnClaim = edge === "claim";
    await active.tick();
    expect(fake.messages).toHaveLength(1);
    expect(claims()).toBe(0);
    expect(rows().filter((r) => r.status === "pending")).toMatchObject([
      { attempts: 0, digest_id: "rate:queued" },
      { attempts: 0, digest_id: "rate:queued" },
    ]);
    advance(60_000);
    await active.tick();
    expect(fake.messages.slice(1)).toEqual([
      { title: "2 条待处理", url: config.workbench_url },
    ]);
  },
);

test("50 new items share one rolling channel budget across projects, ticks, senders and restart", async () => {
  const other = "other-project";
  store.createProject({ id: other, name: "Other" });
  store.uow.run((tx) => tx.cards.put(other, card()));
  const active = sender();
  active.recordStatus();
  // Cross a wall-clock minute boundary while the rolling window is still full.
  advance(59_900);
  for (let n = 1; n <= 40; n++) addAction(n);
  for (let n = 1; n <= 10; n++) addAction(n, other);
  await Promise.all([active.tick(), sender().tick()]);
  advance(100);
  await active.tick();
  expect(fake.messages).toHaveLength(10);
  store.close();
  store = Store.open({ dataDir: dir });
  advance(59_899);
  await sender().tick();
  expect(fake.messages).toHaveLength(10);
  advance(1);
  await sender().tick();
  expect(fake.messages.slice(10)).toEqual([
    { title: "40 条待处理", url: config.workbench_url },
  ]);
  expect(rows().filter((r) => r.status === "sent")).toHaveLength(50);
  advance(60_000);
  await sender().tick();
  expect(fake.messages).toHaveLength(11);
});

test("a configured one-slot channel counts retry attempts and its count-only summary; quiet hours still suppress delivery", async () => {
  config = {
    ...config,
    policy: { ...config.policy, max_per_minute: 1 },
    quiet_hours: { timezone: "UTC", start: "00:01", end: "00:02" },
  };
  startChannel();
  fake.result = "retryable";
  await sender().tick();
  addAction(2);
  addAction(3);
  advance(30_000);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  fake.result = "sent";
  advance(30_000);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  advance(60_000);
  await sender().tick();
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(60_000);
  await sender().tick();
  expect(fake.messages.slice(1)).toHaveLength(2);
  expect(fake.messages.slice(1)).toEqual(
    expect.arrayContaining([summaryOf(1), summaryOf(2)]),
  );
  expect(rows().map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
});

test("a failed overflow summary retries in its original group and drops handled members", async () => {
  config = { ...config, policy: { ...config.policy, max_per_minute: 1 } };
  startChannel();
  addAction(2);
  addAction(3);
  await sender().tick();
  fake.result = "retryable";
  advance(60_000);
  await sender().tick();
  expect(fake.messages[1]).toEqual({
    title: "2 条待处理",
    url: config.workbench_url,
  });
  const frozen = rows().find((r) => r.item_id === "H-2")!.digest_id;
  expect(frozen).toMatch(/^rate:/);
  store.close();
  store = Store.open({ dataDir: dir });
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, {
      ...action,
      id: "H-2",
      key: "H-2",
      status: "done",
    }),
  );
  fake.result = "sent";
  advance(30_000);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(30_000);
  await sender().tick();
  expect(fake.messages.slice(2)).toEqual([
    { title: "1 条待处理", url: config.workbench_url },
  ]);
  expect(rows().find((r) => r.item_id === "H-3")).toMatchObject({
    digest_id: frozen,
    attempts: 2,
    status: "sent",
  });
});

test("quiet digest survives restart, omits handled items and reveals no individual links", async () => {
  quiet();
  startChannel();
  for (let n = 2; n <= 23; n++) addAction(n);
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  expect(
    rows().every((r) => r.attempts === 0 && r.digest_id === "queued"),
  ).toBe(true);
  store.close();
  store = Store.open({ dataDir: dir });
  store.uow.run((tx) => {
    tx.human_actions.put(project_id, { ...action, status: "done" });
    tx.cards.put(project_id, card({ sensitive: true }));
  });
  advance(8 * 3600000);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toEqual(summaryOf(22));
  expect(rows().filter((r) => r.status === "sent")).toHaveLength(22);
  expect(rows().find((r) => r.item_id === "H-1")?.status).toBe("skipped");
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
});

test("restart after quiet hours projects unscanned source events into one digest", async () => {
  quiet();
  startChannel();
  addAction(2);
  advance(8 * 3600000);
  // Both source events happened while quiet, even though no sender was running then.
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toEqual(summaryOf(2));
  addAction(3);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  expect(fake.messages[1]).not.toHaveProperty("items");
});

test("recovery spanning two projection batches sends one quiet digest and does not hold ordinary messages", async () => {
  quiet();
  startChannel();
  // Insert one ordinary item amongst 33 quiet-hour members. None has been projected yet.
  advance(8 * 3600000);
  addAction(2);
  advance(-8 * 3600000);
  for (let n = 3; n <= 34; n++) addAction(n);
  advance(8 * 3600000);
  await sender().tick();
  expect(rows()).toHaveLength(32);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toMatchObject({ item: "H-2" });
  // A new process must recognize the unfinished digest from persisted rows.
  store.close();
  store = Store.open({ dataDir: dir });
  await sender().tick();
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  expect(fake.messages[1]).toEqual(summaryOf(33));
  expect(rows().filter((r) => r.status === "sent")).toHaveLength(34);
});

const startQuietBacklog = (count: number) => {
  quiet();
  startChannel();
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, { ...action, status: "done" }),
  );
  now = "2026-01-01T22:00:00.000Z";
  for (let n = 2; n <= count + 1; n++) addAction(n);
  now = "2026-01-02T07:59:59.000Z";
};

test("a quiet scan just before wake keeps all 33 earlier ready items in one digest", async () => {
  startQuietBacklog(33);
  const active = sender();
  await active.tick();
  expect(rows()).toHaveLength(32);
  expect(rows().every((r) => r.digest_id === "queued")).toBe(true);
  expect(fake.messages).toEqual([]);
  advance(1000);
  await active.tick();
  expect(fake.messages).toEqual([summaryOf(33)]);
  expect(rows().filter((r) => r.status === "sent")).toHaveLength(33);
});

test("after restart only surviving quiet-scan members join the digest, not new ordinary items", async () => {
  startQuietBacklog(65);
  await sender().tick();
  const queued = new Set(rows().map((r) => r.item_id));
  expect(queued.size).toBe(32);
  const handled = Array.from(
    { length: 65 },
    (_, i) => `H-${i + 2}` as const,
  ).find((id) => !queued.has(id));
  if (!handled) throw new Error("Expected unqueued backlog");
  store.close();
  store = Store.open({ dataDir: dir });
  advance(1000);
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, {
      ...action,
      id: handled,
      key: handled,
      status: "done",
    }),
  );
  addAction(1000);
  const active = sender();
  await active.tick();
  expect(rows()).toHaveLength(64);
  expect(fake.messages).toMatchObject([{ item: "H-1000" }]);
  await active.tick();
  await active.tick();
  expect(fake.messages).toMatchObject([{ item: "H-1000" }, summaryOf(64)]);
  expect(rows().some((r) => r.item_id === handled)).toBe(false);
  expect(
    store.database.prepare("SELECT 1 FROM ext_message_quiet_overflow").get(),
  ).toBeUndefined();
});

test("an awake projection cannot overwrite a quiet scan committed by a concurrent sender", async () => {
  startQuietBacklog(33);
  const other = Store.open({ dataDir: dir });
  try {
    const asleep = sender({
      store: other,
      clock: { now: () => "2026-01-02T07:59:59.000Z" },
    });
    advance(1000);
    const awake = sender();
    let quietTick: Promise<void> | undefined;
    store.observe({
      transaction(kind) {
        if (kind !== "read") return;
        store.observe(undefined);
        // No command-state revision changes when only projection rows are written.
        quietTick = asleep.tick();
      },
    });
    await awake.tick();
    await quietTick;
    expect(fake.messages).toEqual([]);
    expect(rows()).toHaveLength(32);
    await awake.tick();
    expect(fake.messages).toEqual([summaryOf(33)]);
  } finally {
    other.close();
  }
});

test("digest retries preserve the approved budget and membership across restart and local commit failure", async () => {
  quiet();
  startChannel();
  addAction(2);
  await sender().tick();
  advance(8 * 3600000);
  store.database.exec(`CREATE TRIGGER fail_digest BEFORE INSERT ON events WHEN NEW.type = 'ext_message_sent'
    BEGIN SELECT RAISE(ABORT, 'digest commit failure'); END`);
  await expect(sender().tick()).rejects.toThrow("digest commit failure");
  expect(rows().every((r) => r.attempts === 1 && r.status === "pending")).toBe(
    true,
  );
  expect(new Set(rows().map((r) => r.digest_id)).size).toBe(1);
  store.database.exec("DROP TRIGGER fail_digest");
  store.close();
  store = Store.open({ dataDir: dir });
  fake.result = "retryable";
  advance(39999);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  advance(1);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(59999);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(1);
  await sender().tick();
  expect(fake.messages).toHaveLength(3);
  expect(rows().every((r) => r.attempts === 3 && r.status === "failed")).toBe(
    true,
  );
  // One terminal notice per original outbox item, never an external notification of that notice.
  expect(
    store.uow.read((tx) => notices(loadCommandState(tx, project_id))),
  ).toHaveLength(2);
  await sender().tick();
  expect(fake.messages).toHaveLength(3);
  expect(rows()).toHaveLength(2);
});

test("a digest is claimed atomically by concurrent senders and retry drops newly handled members", async () => {
  quiet();
  startChannel();
  addAction(2);
  await sender().tick();
  advance(8 * 3600000);
  const response = Promise.withResolvers<"retryable">();
  const send = vi.fn(() => response.promise);
  const first = sender({ adapters: { fake: () => ({ send }) } }).tick();
  await sender({ adapters: { fake: () => ({ send }) } }).tick();
  expect(send).toHaveBeenCalledTimes(1);
  response.resolve("retryable");
  await first;
  store.uow.run((tx) => {
    tx.human_actions.put(project_id, { ...action, status: "done" });
    tx.cards.put(project_id, card({ sensitive: true }));
  });
  advance(30000);
  await sender().tick();
  expect(fake.messages[0]).toEqual(summaryOf(1));
  expect(rows().find((r) => r.item_id === "H-1")).toMatchObject({
    attempts: 1,
    status: "skipped",
  });
  expect(rows().find((r) => r.item_id === "H-2")).toMatchObject({
    attempts: 2,
    status: "sent",
  });
});

test("a concurrent write after projection invalidates the batch; next tick uses fresh sensitivity", async () => {
  startChannel();
  const other = Store.open({ dataDir: dir });
  try {
    const active = sender();
    store.observe({
      transaction(kind) {
        if (kind !== "read") return;
        store.observe(undefined);
        other.uow.run((tx) =>
          tx.cards.put(project_id, card({ sensitive: true })),
        );
      },
    });
    await active.tick();
    expect(rows()).toEqual([]);
    await active.tick();
    expect(fake.messages.map((m) => m.title)).toEqual([
      "有 1 条敏感事项待处理",
    ]);
  } finally {
    other.close();
  }
});

test("an external edit during send is not mistaken for our settlement audit", async () => {
  startChannel();
  addAction(2);
  const active = sender({
    adapters: {
      fake: () => ({
        async send(m) {
          fake.messages.push(m);
          if (fake.messages.length === 1)
            store.uow.run((tx) =>
              tx.cards.put(project_id, card({ sensitive: true })),
            );
          return "sent";
        },
      }),
    },
  });
  await active.tick();
  expect(fake.messages).toHaveLength(1);
  await active.tick();
  expect(fake.messages[1]?.title).toBe("有 1 条敏感事项待处理");
});

test.each([false, true])(
  "production-size live backlog bounds computation, replay writes and writer lock time (quiet overflow: %s)",
  async (quietOverflow) => {
    config = { ...config, policy: { ...config.policy, max_per_minute: 100 } };
    if (quietOverflow) {
      quiet();
      now = "2026-01-01T22:00:00.000Z";
    }
    startChannel();
    // Keep the creation facts at the end of the stream ordering (a worst-case linear find).
    store.uow.run((tx) => {
      store.database
        .prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<150000)
      INSERT INTO events(project_id,id,card_id,stream,seq,type,doc)
      SELECT ?, 'history-'||i, NULL,'',i,'tick', json_object('id','history-'||i,'seq',i,'type','tick','payload',json('{}'),'actor',json_object('kind','system','project_id',?),'created_at',?) FROM n`)
        .run(project_id, project_id, now);
      const fact = (
        payload: { decision_id: string } | { human_action_id: string },
      ) =>
        tx.events.append(project_id, {
          id: tx.ids.nextEventId(),
          card_id: "C-1",
          seq: tx.ids.nextEventSequence(project_id, "C-1"),
          type:
            "decision_id" in payload
              ? "decision_requested"
              : "human_action_requested",
          actor: { kind: "human", project_id },
          created_at: now,
          payload,
        });
      for (let n = 1; n <= 1000; n++) {
        const id = `Q-${n}` as Decision["id"];
        tx.decisions.put(project_id, {
          id,
          key: id,
          card_id: "C-1",
          kind: "choose",
          question: "Fixture",
          context: "",
          raised_by: "human",
          decider: "human",
          status: "open",
          category: "general",
          blocking: false,
          affected_cards: [],
          affected_work_items: [],
          options: [],
          recommended: "",
          doc_refs: [],
        });
        fact({ decision_id: id });
      }
      for (let n = 2; n <= 200; n++) {
        const id = `H-${n}` as HumanAction["id"];
        tx.human_actions.put(project_id, { ...action, id, key: id });
        fact({ human_action_id: id });
      }
    });
    expect(
      store.database.prepare("SELECT COUNT(*) AS n FROM events").get()?.n,
    ).toBe(151200);
    if (quietOverflow) now = "2026-01-02T07:59:59.000Z";
    const active = sender();
    // First tick includes cold SQLite/JSON decoding. Second tick sees our audits,
    // so it must reproject (and take the next batch), not hit an unchanged cursor.
    for (const cold of [true, false]) {
      if (quietOverflow && !cold) advance(1000);
      const locks: number[] = [];
      let compute = 0;
      store.observe({
        transaction(kind, ms) {
          if (kind === "run") locks.push(ms);
          else compute += ms;
        },
      });
      const start = performance.now();
      await active.tick();
      const elapsed = performance.now() - start,
        longest = Math.max(...locks);
      console.info(
        `ext-message (${quietOverflow ? "quiet" : "ordinary"}, ${cold ? "cold" : "warm"}): projection ${compute.toFixed(1)} ms, tick ${elapsed.toFixed(1)} ms, longest write ${longest.toFixed(1)} ms`,
      );
      expect(rows()).toHaveLength(cold ? 32 : 64);
      expect(fake.messages).toHaveLength(quietOverflow ? 0 : cold ? 32 : 64);
      expect(compute).toBeLessThan(cold ? 2000 : 200);
      expect(elapsed).toBeLessThan(cold ? 3000 : 750);
      expect(longest).toBeLessThan(50);
    }
  },
  20000,
);
