import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  FIXTURE_PROJECT,
  generateFixture,
} from "../../test-support/synthetic-fixture.mjs";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { cardSelectors } from "./card-selectors.js";
import { readCachedCardsPage } from "./cards-cache.js";
import {
  cardListViews,
  needsMe,
  projectState,
  waitingOnAgent,
} from "./read.js";

test("lightweight selectors agree with full workflow views without reading event or timeline history", async () => {
  const f = await webHarness();
  try {
    seedWebProject(f.store, f.dataDir);
    const expected = cardListViews(projectState(f.store, project_id))
      .filter((c) => !["done", "cancelled"].includes(c.status))
      .map((c) => ({
        id: c.id,
        status: c.status,
        needs_me: Number(needsMe(c)),
        agent: Number(waitingOnAgent(c)),
        human: Number(
          needsMe(c) ||
            c.waiting_on.some((w) =>
              ["decision", "human_action"].includes(w.kind),
            ),
        ),
        blocked: Number(
          c.waiting_on.some((w) => ["blocked", "review"].includes(w.kind)),
        ),
      }));
    const actual = f.store.uow.read((tx) =>
      cardSelectors(
        {
          ...tx,
          events: {
            listAfter: () => {
              throw new Error("must not load events for counts");
            },
          },
          timeline: {
            get: () => {
              throw new Error("must not load timeline");
            },
            list: () => {
              throw new Error("must not load timeline");
            },
          },
        },
        project_id,
      ),
    );
    expect(actual).toEqual(expected);
  } finally {
    await f.close();
  }
});

test("selectors preserve the full synthetic workflow distribution, including review targets and decision owners", async () => {
  const f = await webHarness();
  let store: Store | undefined;
  try {
    const dataDir = join(f.dataDir, "selectors");
    await generateFixture({ out: dataDir, seed: 386, profile: "small" });
    store = Store.open({ dataDir });
    const expected = cardListViews(projectState(store, FIXTURE_PROJECT))
      .filter((c) => !["done", "cancelled"].includes(c.status))
      .map((c) => ({
        id: c.id,
        status: c.status,
        needs_me: Number(needsMe(c)),
        agent: Number(waitingOnAgent(c)),
        human: Number(
          needsMe(c) ||
            c.waiting_on.some((w) =>
              ["decision", "human_action"].includes(w.kind),
            ),
        ),
        blocked: Number(
          c.waiting_on.some((w) => ["blocked", "review"].includes(w.kind)),
        ),
      }));
    expect(store.uow.read((tx) => cardSelectors(tx, FIXTURE_PROJECT))).toEqual(
      expected,
    );
  } finally {
    store?.close();
    await f.close();
  }
});

test("cards reuse a bounded snapshot, return deltas and invalidate on other connections, filters and rollback", async () => {
  const f = await webHarness();
  const store = Store.open({ dataDir: f.dataDir });
  let other: Store | undefined;
  try {
    seedWebProject(store, f.dataDir);
    const read = (query = "") =>
      readCachedCardsPage(
        store,
        project_id,
        new URL(`http://fixture/cards?view=summary&${query}`),
      );
    const first = read();
    const prepare = vi.spyOn(store.database, "prepare");
    const same = read(`since_version=${first.snapshot_version}`);
    expect(same).toMatchObject({
      delta: true,
      cards: [],
      card_ids: first.cards.map((c) => c.id),
    });
    expect(prepare.mock.calls.some(([sql]) => sql.includes("FROM cards"))).toBe(
      false,
    );
    prepare.mockRestore();
    other = Store.open({ dataDir: f.dataDir });
    other.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1");
      if (!card) throw new Error("missing fixture");
      tx.cards.put(project_id, {
        ...card,
        title: "Changed through another connection",
      });
    });
    const changed = read(`since_version=${first.snapshot_version}`);
    expect(changed.snapshot_version).not.toBe(first.snapshot_version);
    expect(changed.cards).toHaveLength(1);
    expect(changed.cards[0]?.title).toBe("Changed through another connection");
    expect(
      read(`q=C-2&since_version=${changed.snapshot_version}`),
    ).not.toHaveProperty("delta");
    expect(() =>
      store.uow.run((tx) => {
        const card = tx.cards.get(project_id, "C-1");
        if (!card) throw new Error("missing fixture");
        tx.cards.put(project_id, { ...card, title: "Rolled back" });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(read().cards.find((c) => c.id === "C-1")?.title).toBe(
      "Changed through another connection",
    );
    store.createProject({ id: "other" });
    expect(
      readCachedCardsPage(store, "other", new URL("http://fixture/cards")),
    ).toMatchObject({ cards: [], counts: { total: 0 } });
    // The cache can be disabled for diagnosis without changing the wire contract.
    const uncached = new URL("http://fixture/cards");
    const firstUncached = readCachedCardsPage(store, project_id, uncached, {
      ttlMs: 0,
    });
    const reads = vi.spyOn(store.database, "prepare");
    expect(
      readCachedCardsPage(store, project_id, uncached, { ttlMs: 0 }),
    ).toEqual(firstUncached);
    expect(reads.mock.calls.some(([sql]) => sql.includes("FROM cards"))).toBe(
      true,
    );
    reads.mockRestore();
  } finally {
    other?.close();
    store.close();
    await f.close();
  }
});

test("a warm card cache still requires a valid HTTP session", async () => {
  const f = await webHarness({ password: "cards-test-password" });
  try {
    seedWebProject(f.store, f.dataDir);
    const cookie = await f.login("cards-test-password");
    const path = `/api/projects/${project_id}/cards`;
    expect((await call(f.port, path, { cookie })).status).toBe(200);
    expect((await call(f.port, path)).status).toBe(401);
  } finally {
    await f.close();
  }
});
