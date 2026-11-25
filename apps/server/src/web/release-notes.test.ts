import { afterEach, beforeEach, expect, test } from "vitest";
import { type M4Cross, m4Cross } from "../../test-support/m4-cross.js";
import { resolveWebConfig } from "./config.js";
import { type RunningWebServer, startWebServer } from "./server.js";

let s: M4Cross, web: RunningWebServer, cookie: string;
const password = "workbench test password";
const path = () => `/api/projects/${s.project.project_id}/release-notes`;
let key = 0;
async function save(body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(web.url + path(), {
    method: "POST",
    headers: {
      cookie,
      origin: web.url,
      "content-type": "application/json",
      "idempotency-key": `release-note-${++key}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
async function list(query = "") {
  const response = await fetch(web.url + path() + query, {
    headers: { cookie },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
beforeEach(async () => {
  s = await m4Cross();
  s.store().setWebPassword(password);
  web = await startWebServer({
    store: s.store(),
    dataDir: s.dataDir,
    config: resolveWebConfig({}, { port: 0, staticDir: s.root }),
  });
  const login = await fetch(`${web.url}/api/login`, {
    method: "POST",
    headers: { origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
  expect(login.status).toBe(200);
  await login.body?.cancel();
});
afterEach(async () => {
  await web?.close();
  await s?.close();
}, 30_000);

test("C-712 the human saves and revises a release note through the Workbench API and reads it back", async () => {
  expect(await list()).toEqual({ status: 200, body: { entries: [] } });
  expect((await save({ version: "0.4.2", body: "未发布" })).status).toBe(400);
  s.store().uow.run((tx) => {
    for (const [version, at] of [
      ["0.4.2", "2026-01-02T00:00:00.000Z"],
      ["0.5.0", "2026-01-03T00:00:00.000Z"],
    ] as const)
      tx.events.append(s.project.project_id, {
        id: tx.ids.nextEventId(),
        card_id: s.card.id,
        seq: tx.ids.nextEventSequence(s.project.project_id, s.card.id),
        type: "artifact_publication_verified",
        actor: { kind: "system", project_id: s.project.project_id },
        payload: { version, versionCode: 1, decision_id: "Q-1" },
        created_at: at,
      });
  });
  const created = await save({ version: "0.4.2", body: "新增设置页" });
  expect(created).toMatchObject({
    status: 200,
    body: {
      note: {
        version: "0.4.2",
        body: "新增设置页",
        revision: 1,
        author: "human",
      },
      changed: true,
      merged_cards: { basis: "recent" },
    },
  });
  // A stale revision and an empty body are rejected without a write.
  expect(
    (await save({ version: "0.4.2", body: "x", base_revision: 0 })).status,
  ).toBe(409);
  expect((await save({ version: "0.4.2", body: "  " })).status).toBe(400);
  expect((await save({ version: "0.4.2", body: "x", extra: 1 })).status).toBe(
    400,
  );
  expect(
    (
      await save({
        version: "0.4.2",
        body: "新增设置页，修复闪退",
        base_revision: 1,
      })
    ).body,
  ).toMatchObject({ note: { revision: 2 } });
  const listed = await list();
  expect(listed.body).toMatchObject({
    entries: [
      { version: "0.5.0", note: null },
      {
        version: "0.4.2",
        published_at: "2026-01-02T00:00:00.000Z",
        note: {
          body: "新增设置页，修复闪退",
          revision: 2,
          author_view: { author_display: expect.any(String) },
        },
      },
    ],
  });
  const one = await list("?version=0.4.2");
  expect(
    (one.body.history as { revision: number; body: string }[]).map((r) => [
      r.revision,
      r.body,
    ]),
  ).toEqual([
    [1, "新增设置页"],
    [2, "新增设置页，修复闪退"],
  ]);
  expect((await list("?version=..%2Fx")).status).toBe(400);
  // Idempotency: the same key and body replays, a different body conflicts.
  const replay = { "idempotency-key": "same-key" };
  const first = await save({ version: "0.5.0", body: "a" }, replay);
  expect(await save({ version: "0.5.0", body: "a" }, replay)).toEqual(first);
  expect((await save({ version: "0.5.0", body: "b" }, replay)).status).toBe(
    409,
  );
});
