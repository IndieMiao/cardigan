import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { CardId, ProjectId } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  FIXTURE_NOW,
  FIXTURE_PROJECT,
  generateFixture,
} from "../../test-support/synthetic-fixture.mjs";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { matchesValidator, readCardDetailCached } from "./card-detail-cache.js";
import { runWorkbenchRead } from "./read-ops.js";

const password = "card-detail-load-test";

test("C-688: an unchanged card detail answers 304 to its validator, a changed one answers in full", async () => {
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    const cookie = await f.login(password);
    const path = `/api/projects/${project_id}/cards/C-1?limit=20&section=overview`;
    const first = await call(f.port, path, { cookie });
    expect(first.status).toBe(200);
    const etag = first.headers.etag;
    expect(etag).toMatch(/^W\/"[\w-]{32}"$/);
    expect(first.headers["cache-control"]).toBe("no-store");

    const same = await call(f.port, path, {
      cookie,
      headers: { "if-none-match": String(etag) },
    });
    expect(same.status).toBe(304);
    expect(same.body).toBe("");
    expect(same.headers.etag).toBe(etag);
    // Weak comparison, lists too; another validator does not match.
    expect(
      (
        await call(f.port, path, {
          cookie,
          headers: {
            "if-none-match": `"other", ${String(etag).replace(/^W\//, "")}`,
          },
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await call(f.port, path, {
          cookie,
          headers: { "if-none-match": '"other"' },
        })
      ).status,
    ).toBe(200);
    // The session check runs before any validator is compared.
    expect(
      (
        await call(f.port, path, {
          headers: { "if-none-match": String(etag) },
        })
      ).status,
    ).toBe(401);
    // Each section and query has its own validator.
    const timeline = await call(
      f.port,
      `/api/projects/${project_id}/cards/C-1?section=timeline`,
      { cookie, headers: { "if-none-match": String(etag) } },
    );
    expect(timeline.status).toBe(200);
    expect(timeline.headers.etag).not.toBe(etag);

    // A write elsewhere moves every version: the read runs again and still
    // finds the same content.
    f.store.uow.run((tx) => {
      const other = tx.cards.get(project_id, "C-3" as CardId);
      if (!other) throw new Error("missing fixture card");
      tx.cards.put(project_id, { ...other, title: "Another title" });
    });
    expect(
      (
        await call(f.port, path, {
          cookie,
          headers: { "if-none-match": String(etag) },
        })
      ).status,
    ).toBe(304);

    // A client that accepts gzip gets the same body compressed, same validator.
    const zipped = await call(f.port, path, {
      cookie,
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(zipped.status).toBe(200);
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers.vary).toBe("Accept-Encoding");
    expect(zipped.headers.etag).toBe(etag);
    expect(Number(zipped.headers["content-length"])).toBe(zipped.bytes.length);
    expect(zipped.bytes.length).toBeLessThan(Buffer.byteLength(first.body));
    // Only the `now` stamp may differ: the write above re-read the card.
    const { now: _zippedAt, ...unzipped } = JSON.parse(
      gunzipSync(zipped.bytes).toString("utf8"),
    );
    const { now: _firstAt, ...plain } = JSON.parse(first.body);
    expect(unzipped).toEqual(plain);

    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1" as CardId);
      if (!card) throw new Error("missing fixture card");
      tx.cards.put(project_id, { ...card, title: "Renamed for C-688" });
    });
    const changed = await call(f.port, path, {
      cookie,
      headers: { "if-none-match": String(etag) },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
    expect(JSON.parse(changed.body).card.title).toBe("Renamed for C-688");
  } finally {
    await f.close();
  }
});

test("C-688: the validator ignores the response stamp, the cache keeps one answer per query until a write or its expiry", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "p-cache" as ProjectId });
    let reads = 0;
    let now = "2026-01-01T00:00:00.000Z";
    let title = "first";
    const request = {
      project: "p-cache" as ProjectId,
      card: "C-1" as CardId,
      url: "http://fixture/cards/C-1?section=overview&limit=20",
      mergeGateStatus: "disabled",
    };
    const read = () => {
      reads++;
      return { card: { title }, now };
    };
    const first = readCardDetailCached(store, request, read);
    expect(first.notModified).toBe(false);
    expect(JSON.parse(first.body ?? "")).toEqual({ card: { title }, now });
    // Same versions, within the expiry: no second read, even reordered params.
    expect(
      readCardDetailCached(
        store,
        {
          ...request,
          url: "http://fixture/cards/C-1?limit=20&section=overview",
        },
        read,
      ),
    ).toEqual(first);
    expect(reads).toBe(1);
    expect(
      readCardDetailCached(
        store,
        { ...request, ifNoneMatch: first.etag },
        read,
      ),
    ).toEqual({ etag: first.etag, notModified: true });
    expect(reads).toBe(1);

    // Expired: read again; only the stamp moved, so the validator holds.
    const expiring = { ...request, url: `${request.url}&at=entry-1` };
    const stored = readCardDetailCached(store, expiring, read, { ttlMs: 0 });
    expect(reads).toBe(2);
    now = "2026-01-01T00:00:09.000Z";
    const later = readCardDetailCached(
      store,
      { ...expiring, ifNoneMatch: stored.etag },
      read,
      { ttlMs: 0 },
    );
    expect(reads).toBe(3);
    expect(later).toEqual({ etag: stored.etag, notModified: true });

    // A committed write invalidates at once, whatever the expiry.
    title = "second";
    store.uow.run((tx) =>
      tx.cards.put(
        "p-cache" as ProjectId,
        {
          id: "C-1" as CardId,
          project_id: "p-cache" as ProjectId,
          title,
          goal: "",
          acceptance_criteria: [],
          source: { kind: "quote", text: "" },
          priority: 1,
          status: "todo",
          template: "dev",
          created_by: "human",
          created_at: now,
        } as never,
      ),
    );
    const changed = readCardDetailCached(
      store,
      { ...request, ifNoneMatch: first.etag },
      read,
    );
    expect(reads).toBe(4);
    expect(changed.notModified).toBe(false);
    expect(changed.etag).not.toBe(first.etag);
    expect(JSON.parse(changed.body ?? "").card.title).toBe("second");

    // Compressed once per answer; small answers are sent as they are.
    const big = () => ({ card: { title: "x".repeat(4096) }, now });
    const zipRequest = { ...request, url: `${request.url}&zip=1` };
    const zipped = readCardDetailCached(
      store,
      { ...zipRequest, acceptGzip: true },
      big,
    );
    expect(zipped.body).toBeUndefined();
    expect(gunzipSync(zipped.gzip ?? new Uint8Array()).toString()).toBe(
      JSON.stringify(big()),
    );
    expect(
      readCardDetailCached(store, { ...zipRequest, acceptGzip: true }, big)
        .gzip,
    ).toBe(zipped.gzip);
    expect(readCardDetailCached(store, zipRequest, big).body).toBe(
      JSON.stringify(big()),
    );
    expect(
      readCardDetailCached(store, { ...request, acceptGzip: true }, read).gzip,
    ).toBeUndefined();

    // Bounded: the oldest query is dropped first.
    for (let i = 0; i < 3; i++)
      readCardDetailCached(
        store,
        { ...request, url: `http://fixture/cards/C-1?limit=${i + 1}` },
        read,
        { maxEntries: 2 },
      );
    const before = reads;
    readCardDetailCached(
      store,
      { ...request, url: "http://fixture/cards/C-1?limit=1" },
      read,
      { maxEntries: 2 },
    );
    expect(reads).toBe(before + 1);
  } finally {
    store.close();
  }
});

test("C-688: If-None-Match parsing", () => {
  expect(matchesValidator(undefined, '"a"')).toBe(false);
  expect(matchesValidator('"a"', '"a"')).toBe(true);
  expect(matchesValidator('W/"a"', '"a"')).toBe(true);
  expect(matchesValidator('"a"', 'W/"a"')).toBe(true);
  expect(matchesValidator('"b" , "a"', '"a"')).toBe(true);
  expect(matchesValidator("*", '"a"')).toBe(true);
  expect(matchesValidator('"b"', '"a"')).toBe(false);
});

// The CI guard for detail reads: whatever the project's size, no statement a
// detail read runs may walk a whole project table. A refreshed cache list
// (only after a write, and without decoding JSON) is its own maintenance.
let root: string;
let fixtureStore: Store;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "card-detail-load-"));
  await generateFixture({ out: join(root, "data"), profile: "small" });
  fixtureStore = Store.open({ dbPath: join(root, "data", "cardigan.db") });
});
afterAll(async () => {
  fixtureStore?.close();
  await rm(root, { recursive: true, force: true });
});

const DOC_TABLES =
  "cards|work_items|assignments|runs|deliveries|reviews|decisions|human_actions|attachments|timeline|events";
const PROJECT_WIDE = new RegExp(
  `^(?:SCAN (?:${DOC_TABLES})\\b|SEARCH (?:${DOC_TABLES}) USING (?:COVERING )?(?:INDEX \\S+|PRIMARY KEY) \\(project_id=\\?\\)$)`,
);
const CACHE_REFRESH = /AS entity_key, typeof\(doc\) FROM /;

test("C-688: detail reads seek by card and never walk a whole project table", async () => {
  const store = fixtureStore;
  const project = FIXTURE_PROJECT as ProjectId;
  store.uow.run((tx) =>
    tx.events.append(project, {
      id: "c688-queue",
      seq: tx.ids.nextEventSequence(project, undefined),
      type: "merge_queue_configured",
      actor: { kind: "system", project_id: project },
      payload: { max_batch_size: 3 },
      created_at: FIXTURE_NOW,
    } as never),
  );
  const cards = store.uow.read((tx) => tx.cards.list(project));
  const sample = [
    ...new Map(cards.map((c) => [c.status, c.id])).values(),
    ...cards.filter((c) => c.story).map((c) => c.id),
  ];
  expect(sample.length).toBeGreaterThan(4);
  const queries = [
    "?limit=20&section=overview",
    "?limit=20",
    "?section=timeline",
    "?section=work",
    "?section=records",
    "?section=attachments",
  ];
  let stamp = 0;
  const read = (card: string, query: string) =>
    runWorkbenchRead(store, {
      kind: "card",
      project,
      card: card as CardId,
      // A fresh query per read: the answer cache must not hide the SQL.
      url: `http://fixture/cards/${card}${query}&_=${stamp++}`,
      mergeGateStatus: "enabled",
      now: FIXTURE_NOW,
    });
  for (const card of sample) for (const q of queries) await read(card, q);

  const db = store.database;
  const prepare = db.prepare.bind(db);
  const seen: [string, unknown[]][] = [];
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === "all" || key === "get" || key === "iterate")
          return (...args: unknown[]) => {
            seen.push([sql, args]);
            return value.apply(target, args);
          };
        return value.bind(target);
      },
    });
  }) as typeof db.prepare;
  try {
    // A background write between reads, as in production.
    store.uow.run((tx) => {
      const run = tx.runs.list(project)[0];
      if (run) tx.runs.put(project, { ...run, summary: "background" });
    });
    for (const card of sample) for (const q of queries) await read(card, q);
  } finally {
    db.prepare = prepare;
  }
  expect(seen.length).toBeGreaterThan(sample.length * queries.length);
  const walks = seen.flatMap(([sql, args]) =>
    CACHE_REFRESH.test(sql)
      ? []
      : db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...(args as never[]))
          .map((row) => String(row.detail))
          .filter((detail) => PROJECT_WIDE.test(detail))
          .map((detail) => `${detail} <- ${sql.replace(/\s+/g, " ")}`),
  );
  expect(walks).toEqual([]);
});
