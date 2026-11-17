import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { readCachedCardsPage, readCardsVersion } from "./cards-cache.js";

test("deletion and closing a card invalidate the version and preserve ordered delta membership", async () => {
  const f = await webHarness();
  try {
    seedWebProject(f.store, f.dataDir);
    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1");
      if (!card) throw new Error("missing fixture");
      tx.cards.put(project_id, { ...card, id: "C-4" });
    });
    const url = new URL("http://fixture/cards?view=summary&sort=id&limit=50");
    const first = readCachedCardsPage(f.store, project_id, url);
    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1");
      if (!card) throw new Error("missing fixture");
      tx.cards.put(project_id, { ...card, status: "done", resolution: "done" });
      f.store.database
        .prepare("DELETE FROM cards WHERE project_id = ? AND id = ?")
        .run(project_id, "C-4");
    });
    const version = readCardsVersion(f.store, project_id, url);
    expect(version.snapshot_version).not.toBe(first.snapshot_version);
    url.searchParams.set("since_version", first.snapshot_version);
    const next = readCachedCardsPage(f.store, project_id, url);
    expect(next).toMatchObject({
      delta: true,
      snapshot_version: version.snapshot_version,
      card_ids: ["C-1", "C-2", "C-3"],
    });
    expect(next.cards.find((c) => c.id === "C-1")?.status).toBe("done");
    expect(next.cards.some((c) => c.id === "C-4")).toBe(false);
  } finally {
    await f.close();
  }
});

test("version probes stay cheap after expiry and track query, project, identity and rollback dependencies", async () => {
  const f = await webHarness();
  try {
    seedWebProject(f.store, f.dataDir);
    const url = new URL("http://fixture/cards?view=summary&sort=updated");
    const options = { ttlMs: 1, readScope: "first-session" };
    const first = readCachedCardsPage(f.store, project_id, url, options);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const prepare = vi.spyOn(f.store.database, "prepare");
    expect(
      readCardsVersion(f.store, project_id, url, options).snapshot_version,
    ).toBe(first.snapshot_version);
    expect(
      prepare.mock.calls.some(([sql]) =>
        /FROM (cards|events|work_items|reviews|runs)\b/.test(sql),
      ),
    ).toBe(false);
    prepare.mockRestore();
    now.mockRestore();
    expect(
      readCardsVersion(f.store, project_id, new URL(`${url}&page=2`), options)
        .snapshot_version,
    ).not.toBe(first.snapshot_version);
    expect(
      readCardsVersion(f.store, project_id, url, {
        ...options,
        readScope: "second-session",
      }).snapshot_version,
    ).not.toBe(first.snapshot_version);
    const version = () =>
      readCardsVersion(f.store, project_id, url, options).snapshot_version;
    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1");
      if (!card) throw new Error("missing fixture");
      tx.cards.put(project_id, { ...card, sensitive: true });
    });
    const changed = version();
    expect(changed).not.toBe(first.snapshot_version);
    expect(
      readCachedCardsPage(f.store, project_id, url, options).snapshot_version,
    ).toBe(changed);
    expect(() =>
      f.store.uow.run(() => {
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(version()).not.toBe(changed);
    f.store.createProject({ id: "other" });
    expect(
      readCardsVersion(f.store, "other", url, options).snapshot_version,
    ).not.toBe(version());
    const beforeOtherWrite = version();
    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1");
      if (!card) throw new Error("missing fixture");
      tx.cards.put("other", { ...card, id: "C-other" });
    });
    // Queue dependencies can live in other projects. Only an authenticated human sees this opaque revision.
    expect(version()).not.toBe(beforeOtherWrite);
    const fresh = Store.open({ dbPath: ":memory:" });
    try {
      seedWebProject(fresh, f.dataDir);
      expect(
        readCardsVersion(fresh, project_id, url, options).snapshot_version,
      ).not.toBe(first.snapshot_version);
    } finally {
      fresh.close();
    }
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

test("version and summary routes enforce the same session/project boundary and keep sensitive cards human-only", async () => {
  const f = await webHarness({ password: "cards-version-password" });
  try {
    seedWebProject(f.store, f.dataDir);
    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1");
      if (!card) throw new Error("missing fixture");
      tx.cards.put(project_id, {
        ...card,
        sensitive: true,
        goal: "Detail-only prose",
      });
    });
    const cookie = await f.login("cards-version-password");
    const path = `/api/projects/${project_id}/cards`;
    const query = "?view=summary&sort=updated";
    const page = (await call(f.port, path + query, { cookie })).json as {
      snapshot_version: string;
      read_scope: string;
      cards: Record<string, unknown>[];
    };
    const version = await call(f.port, `${path}/version${query}`, { cookie });
    expect(version.json).toEqual({
      project_id,
      snapshot_version: page.snapshot_version,
      read_scope: page.read_scope,
    });
    expect(page.cards.find((c) => c.id === "C-1")).toMatchObject({
      sensitive: true,
    });
    const full = (await call(f.port, `${path}?sort=updated`, { cookie }))
      .json as typeof page;
    const allowed = [
      "id",
      "title",
      "status",
      "resolution",
      "superseded_by",
      "sensitive",
      "risk_tags",
      "priority",
      "hold",
      "why",
      "waiting_on",
      "next_owners",
      "queued_runs",
      "produce_owners",
      "participants",
      "work_items",
      "attachment_count",
      "progress",
      "updated_at",
      "roles",
    ];
    expect(page.cards).toEqual(
      full.cards.map((card) =>
        Object.fromEntries(
          Object.entries(card).filter(([key]) => allowed.includes(key)),
        ),
      ),
    );
    expect(full.cards.find((c) => c.id === "C-1")?.goal).toBe(
      "Detail-only prose",
    );
    const detail = (await call(f.port, `${path}/C-1`, { cookie })).json as {
      card: Record<string, unknown>;
    };
    expect(detail.card.goal).toBe("Detail-only prose");
    expect((await call(f.port, `${path}/version${query}`)).status).toBe(401);
    expect(
      (
        await call(f.port, `${path}/version${query}`, {
          headers: { authorization: `Bearer ${page.read_scope}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (await call(f.port, "/api/projects/missing/cards/version", { cookie }))
        .status,
    ).toBe(404);
    const second = await f.login("cards-version-password");
    expect(
      (await call(f.port, `${path}/version${query}`, { cookie: second })).json,
    ).not.toEqual(version.json);
    f.store.revokeWebSession(cookie.split("=")[1] ?? "");
    expect(
      (await call(f.port, `${path}/version${query}`, { cookie })).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});
