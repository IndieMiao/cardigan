import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  Assignment,
  Card,
  CardId,
  Event,
  TransactionContext,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Store, type StoreTransactionContext } from "./index.js";

// Independent acceptance fixtures from M1.4/M1.T2 and development plan §4/§6/§9.
// All business reads/writes use public repositories; SQL is only used for SQLite PRAGMAs.
const project = "acceptance-alpha";
const otherProject = "acceptance-beta";
const now = "2026-01-01T00:00:00.000Z";
let store: Store, dataDir: string, card: Card, assignment: Assignment;
function seed(project_id: string) {
  expect(store.createProject({ id: project_id }).ok).toBe(true);
  return store.uow.run((tx) => {
    const card: Card = {
      id: tx.ids.next(project_id, "card"),
      project_id,
      title: "Acceptance card",
      goal: "Persist atomically",
      acceptance_criteria: ["Pass"],
      source: { kind: "quote", text: "Fixture" },
      out_of_scope: [],
      related_cards: [],
      repo: "example/repo",
      base_branch: "main",
      priority: 1,
      status: "todo",
      template: "development",
      created_by: "human",
      created_at: now,
    };
    const assignment: Assignment = {
      id: tx.ids.next(project_id, "assignment"),
      scope: "standing",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: `${project_id}:pm`,
      created_at: now,
    };
    tx.cards.put(project_id, card);
    tx.assignments.put(project_id, assignment);
    tx.roles.put(project_id, {
      role_id: "pm",
      role_version: 1,
      allowed_tools: ["whoami"],
      capabilities: [],
    });
    return { card, assignment };
  });
}
function append(
  tx: TransactionContext,
  project_id = project,
  card_id: CardId | undefined = card.id,
) {
  const event: Event = {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project_id, card_id),
    type: "acceptance_event",
    actor: { kind: "human", project_id },
    payload: { marker: project_id },
    created_at: now,
    ...(card_id === undefined ? {} : { card_id }),
  };
  tx.events.append(project_id, event);
  if (card_id !== undefined) {
    const id = tx.ids.nextTimelineEntryId(project_id, card_id);
    tx.timeline.put(project_id, {
      id,
      short_id: id,
      card_id,
      event_seq: event.seq,
      type: "comment",
      author: "human",
      refs: [],
      retracted: false,
      body: `Event ${event.seq}`,
      mentions: [],
      created_at: now,
    });
  }
  return event;
}
const snapshot = () =>
  store.uow.read((tx) => ({
    cards: tx.cards.list(project),
    timeline: tx.timeline.list(project),
    events: tx.events.listAfter(project, card.id, 0),
    cursors: tx.cursors.list(project),
  }));
const invocation = () => ({
  project_id: project,
  assignment_id: assignment.id,
  key: "acceptance-key",
  request: { amount: 1, label: "same" },
});
const effect = (tx: StoreTransactionContext) => {
  const created = { ...card, id: tx.ids.next(project, "card") };
  tx.cards.put(project, created);
  return { card_id: created.id, seq: append(tx).seq };
};
function reopen() {
  store.close();
  store = Store.open({ dataDir });
}
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cardigan-store-acceptance-"));
  store = Store.open({ dataDir });
  ({ card, assignment } = seed(project));
});
afterEach(async () => {
  if (store.database.isOpen) store.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("S01: an empty directory migrates to a usable WAL database with foreign keys enabled", async () => {
  expect(store.schemaVersion()).toBeGreaterThan(0);
  expect(store.database.prepare("PRAGMA journal_mode").get()).toMatchObject({
    journal_mode: "wal",
  });
  expect(store.database.prepare("PRAGMA foreign_keys").get()).toMatchObject({
    foreign_keys: 1,
  });
  expect(store.uow.read((tx) => tx.cards.get(project, card.id))).toEqual(card);
  expect(
    (await readFile(join(dataDir, "cardigan.db"))).subarray(0, 16).toString(),
  ).toBe("SQLite format 3\0");
});

test("S02: repeated migrations and reopening preserve records and allocated identifiers", () => {
  const version = store.schemaVersion();
  store.uow.run((tx) => append(tx));
  const before = snapshot();
  expect(store.migrate()).toEqual([]);
  expect(store.migrate()).toEqual([]);
  reopen();
  expect(store.schemaVersion()).toBe(version);
  expect(snapshot()).toEqual(before);
  expect(store.uow.run((tx) => tx.ids.next(project, "card"))).toBe("C-2");
  expect(store.uow.run((tx) => append(tx)).seq).toBe(2);
});

test("S03: a transaction failure rolls back entities, events, timeline, cursors, IDs and Tokens", () => {
  const before = snapshot();
  let token = "";
  expect(() =>
    store.uow.run((tx) => {
      effect(tx);
      tx.cards.put(project, { ...card, title: "Must roll back" });
      tx.cursors.put(project, {
        assignment_id: assignment.id,
        card_id: card.id,
        acked_seq: 1,
      });
      token = tx.issueToken({
        project_id: project,
        assignment_id: assignment.id,
        role: { role_version: 1, allowed_tools: ["whoami"] },
      }).token;
      throw new Error("abort acceptance transaction");
    }),
  ).toThrow("abort acceptance transaction");
  expect(snapshot()).toEqual(before);
  expect(store.verifyToken(token)).toBeUndefined();
  expect(store.uow.run(effect)).toEqual({ card_id: "C-2", seq: 1 });
});

test("S04: card and project streams have independent consecutive sequences and ordered updates", () => {
  const other = seed(otherProject);
  const second = store.uow.run((tx) => {
    const c = { ...card, id: tx.ids.next(project, "card") };
    tx.cards.put(project, c);
    return c;
  });
  for (let i = 0; i < 3; i++)
    store.uow.run((tx) => {
      append(tx);
      append(tx, project, second.id);
      append(tx, otherProject, other.card.id);
      const seq = tx.ids.nextEventSequence(project);
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq,
        type: "project_event",
        actor: { kind: "human", project_id: project },
        payload: {},
        created_at: now,
      });
    });
  for (const scope of [
    { project_id: project, card_id: card.id },
    { project_id: project, card_id: second.id },
    { project_id: otherProject, card_id: other.card.id },
    { project_id: project },
  ]) {
    const updates = store.getUpdates({ ...scope, since_seq: 1 });
    expect(updates.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(updates.latest_seq).toBe(3);
    expect(updates.timeline.map((e) => e.event_seq)).toEqual(
      "card_id" in scope ? [2, 3] : [],
    );
  }
});

test("S05: a duplicate event sequence is refused without replacing the first event", () => {
  const first = store.uow.run((tx) => append(tx));
  expect(() =>
    store.uow.run((tx) =>
      tx.events.append(project, {
        ...first,
        id: tx.ids.nextEventId(),
        payload: { marker: "duplicate" },
      }),
    ),
  ).toThrow();
  expect(
    store.getUpdates({ project_id: project, card_id: card.id }).events,
  ).toEqual([first]);
});

test("S06: ACK is monotonic, rejects future sequences and isolates Assignment cursors", () => {
  for (let i = 0; i < 3; i++) store.uow.run((tx) => append(tx));
  const params = {
    project_id: project,
    assignment_id: assignment.id,
    card_id: card.id,
  };
  expect(store.ackEvents({ ...params, up_to_seq: 2 })).toMatchObject({
    ok: true,
    value: { acked_seq: 2, changed: true },
  });
  for (const up_to_seq of [1, 2])
    expect(store.ackEvents({ ...params, up_to_seq })).toMatchObject({
      ok: true,
      value: { acked_seq: 2, changed: false },
    });
  expect(store.ackEvents({ ...params, up_to_seq: 4 })).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  expect(store.uow.read((tx) => tx.cursors.list(project))).toEqual([
    { assignment_id: assignment.id, card_id: card.id, acked_seq: 2 },
  ]);
  const second = store.uow.run((tx) => {
    const a = {
      ...assignment,
      id: tx.ids.next(project, "assignment"),
      mcp_token_id: "second",
    };
    tx.assignments.put(project, a);
    return a;
  });
  expect(
    store.ackEvents({ ...params, assignment_id: second.id, up_to_seq: 1 }),
  ).toMatchObject({ ok: true, value: { acked_seq: 1 } });
  expect(
    store.uow.read((tx) =>
      tx.cursors.get(project, {
        assignment_id: assignment.id,
        card_id: card.id,
      }),
    )?.acked_seq,
  ).toBe(2);
});

test("S07: idempotent first execution and replay survive reopening without duplicate writes", () => {
  const first = store.runIdempotent(invocation(), effect);
  expect(first).toEqual({
    ok: true,
    value: { replayed: false, value: { card_id: "C-2", seq: 1 } },
  });
  const before = snapshot();
  expect(before.cards.map((c) => c.id)).toEqual(["C-1", "C-2"]);
  expect(before.events.map((e) => e.seq)).toEqual([1]);
  expect(before.timeline.map((e) => e.event_seq)).toEqual([1]);
  reopen();
  const replay = store.runIdempotent(
    { ...invocation(), request: { label: "same", amount: 1 } },
    () => {
      throw new Error("Replay executed callback");
    },
  );
  expect(replay).toEqual({
    ok: true,
    value: { replayed: true, value: { card_id: "C-2", seq: 1 } },
  });
  expect(snapshot()).toEqual(before);
});

test("S08: an idempotency conflict executes nothing and preserves the original response", () => {
  store.runIdempotent(invocation(), effect);
  const before = snapshot();
  let called = false;
  const conflict = store.runIdempotent(
    { ...invocation(), request: { amount: 2, label: "same" } },
    (tx) => {
      called = true;
      return effect(tx);
    },
  );
  expect(conflict).toMatchObject({
    ok: false,
    error: { code: "idempotency_conflict" },
  });
  expect(called).toBe(false);
  expect(snapshot()).toEqual(before);
  expect(store.runIdempotent(invocation(), effect)).toMatchObject({
    ok: true,
    value: { replayed: true, value: { card_id: "C-2", seq: 1 } },
  });
});

test("S09: the same idempotency key is independent across Assignments and projects", () => {
  const other = seed(otherProject);
  const second = store.uow.run((tx) => {
    const a = {
      ...assignment,
      id: tx.ids.next(project, "assignment"),
      mcp_token_id: "second",
    };
    tx.assignments.put(project, a);
    return a;
  });
  for (const [project_id, assignment_id] of [
    [project, assignment.id],
    [project, second.id],
    [otherProject, other.assignment.id],
  ] as const) {
    const params = {
      project_id,
      assignment_id,
      key: "shared-key",
      request: { project_id, assignment_id },
    };
    const run = () =>
      store.runIdempotent(params, () => ({
        owner: `${project_id}/${assignment_id}`,
      }));
    expect(run()).toEqual({
      ok: true,
      value: {
        replayed: false,
        value: { owner: `${project_id}/${assignment_id}` },
      },
    });
    expect(run()).toEqual({
      ok: true,
      value: {
        replayed: true,
        value: { owner: `${project_id}/${assignment_id}` },
      },
    });
  }
});

test("S10: a failed idempotent callback leaves its key reusable and consumes no IDs", () => {
  const before = snapshot();
  expect(() =>
    store.runIdempotent(invocation(), (tx) => {
      effect(tx);
      throw new Error("retry this key");
    }),
  ).toThrow("retry this key");
  expect(snapshot()).toEqual(before);
  expect(store.runIdempotent(invocation(), effect)).toEqual({
    ok: true,
    value: { replayed: false, value: { card_id: "C-2", seq: 1 } },
  });
});

test("S11: Token lookup uses sha256, preserves scope, revokes access and never persists plaintext", async () => {
  const { token, record } = store.issueToken({
    project_id: project,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const digest = createHash("sha256").update(token).digest("hex");
  expect(store.verifyToken(token)).toMatchObject({
    project_id: project,
    assignment_id: assignment.id,
    role_version: 1,
    allowed_tools: ["whoami"],
  });
  expect(store.findTokenByHash(digest)).toEqual(record);
  expect(store.findTokenByHash(token)).toBeUndefined();
  expect(store.verifyToken(`${token}wrong`)).toBeUndefined();
  expect(store.revokeToken(record.id)).toBe(true);
  expect(store.verifyToken(token)).toBeUndefined();
  reopen();
  expect(store.verifyToken(token)).toBeUndefined();
  store.close();
  const bytes = await readFile(join(dataDir, "cardigan.db"));
  expect(bytes.includes(Buffer.from(token))).toBe(false);
  expect(bytes.includes(Buffer.from(digest))).toBe(true);
});

test("S12: concurrent connections allocate unique consecutive seq and commit every event once", async () => {
  // Each worker owns a real SQLite connection. All open before the start barrier.
  const workers: Worker[] = [];
  const tasks = Array.from({ length: 4 }, (_, writer) => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { Store } = await import(workerData.module);
        const db = Store.open({ dataDir: workerData.dataDir });
        parentPort.postMessage('ready');
        parentPort.once('message', () => {
          try {
            const seqs = [];
            for (let i = 0; i < 12; i++) seqs.push(db.uow.run(tx => {
              const seq = tx.ids.nextEventSequence(workerData.project, workerData.card);
              tx.events.append(workerData.project, {
                id: tx.ids.nextEventId(), card_id: workerData.card, seq, type: 'concurrent',
                actor: { kind: 'human', project_id: workerData.project },
                payload: { writer: workerData.writer, i }, created_at: workerData.now,
              });
              return seq;
            }));
            parentPort.postMessage({ seqs });
          } finally { db.close(); }
        });
      })().catch(error => { throw error; });
    `,
      {
        eval: true,
        workerData: {
          module: import.meta.resolve("@cardigan/store"),
          dataDir,
          project,
          card: card.id,
          writer,
          now,
        },
      },
    );
    workers.push(worker);
    const ready = new Promise<void>((resolve, reject) => {
      worker.on("message", (value) => {
        if (value === "ready") resolve();
      });
      worker.once("error", reject);
    });
    const done = new Promise<number[]>((resolve, reject) => {
      worker.on("message", (value) => {
        if (typeof value === "object") resolve(value.seqs);
      });
      worker.once("error", reject);
    });
    return { ready, done };
  });
  // Attach rejection handlers immediately while waiting for all workers to open.
  const completed = Promise.all(tasks.map((t) => t.done));
  void completed.catch(() => undefined);
  try {
    await Promise.all(tasks.map((t) => t.ready));
    for (const worker of workers) worker.postMessage("start");
    const sequences = (await completed).flat().sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
    const events = store.getUpdates({
      project_id: project,
      card_id: card.id,
    }).events;
    expect(events.map((e) => e.seq)).toEqual(sequences);
    expect(new Set(events.map((e) => e.id)).size).toBe(48);
    expect(new Set(events.map((e) => JSON.stringify(e.payload))).size).toBe(48);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}, 15000);
