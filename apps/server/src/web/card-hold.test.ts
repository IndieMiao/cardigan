import { expect, test } from "vitest";
import type {
  CardDetail,
  CardPage,
  NoticesPage,
  SnapshotData,
} from "../../../web/src/api.js";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

test("human hold writes update board/list/detail counts and Needs You without changing the lifecycle", async () => {
  const f = await webHarness({ password: "hold-test-password" });
  try {
    seedWebProject(f.store, f.dataDir);
    const cookie = await f.login("hold-test-password");
    const root = `/api/projects/${project_id}`;
    const get = async <T>(path: string) =>
      (await call(f.port, root + path, { cookie })).json as T;
    const write = (body: unknown, key: string) =>
      call(f.port, `${root}/cards/C-2/update`, {
        method: "POST",
        cookie,
        headers: {
          origin: `http://${f.hostHeader}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
    const hold = { reason: "等待现场证据", resume_condition: "条件确认后恢复" };
    // Warm both caches before the write, so stale active counts cannot hide.
    const before = await get<CardPage>("/cards?mode=board&view=summary");
    expect(before.counts.agent).toBe(1);
    expect(
      (await get<CardPage>("/cards?overview=progress")).cards.some(
        (c) => c.id === "C-2",
      ),
    ).toBe(true);
    expect((await write({ hold }, "hold-1")).status).toBe(200);
    expect((await write({ hold }, "hold-1")).status).toBe(200);
    const board = await get<CardPage>("/cards?mode=board&view=summary");
    const held = board.cards.find((c) => c.id === "C-2");
    expect(held).toMatchObject({
      status: "in_progress",
      hold,
      why: "已暂停：等待现场证据",
    });
    expect(board.lanes?.in_progress?.held_total).toBe(1);
    expect(board.counts.agent).toBe(0);
    expect(
      (await get<CardPage>("/cards?overview=progress")).cards.some(
        (c) => c.id === "C-2",
      ),
    ).toBe(false);
    expect(
      (await get<CardPage>("/cards?filter=agent")).cards.some(
        (c) => c.id === "C-2",
      ),
    ).toBe(false);
    expect((await get<CardDetail>("/cards/C-2")).card.hold).toMatchObject(hold);
    expect(
      (await get<SnapshotData>("/snapshot")).in_progress.some(
        (c) => c.id === "C-2",
      ),
    ).toBe(false);
    const needs = await get<NoticesPage>("/needs-you?section=notices");
    expect(
      needs.notices.some(
        (n) => n.card_id === "C-2" && n.body.includes(hold.resume_condition),
      ),
    ).toBe(true);
    expect(
      (await write({ hold: { ...hold, set_by: "system" } }, "forged")).status,
    ).toBe(400);
    expect((await write({ hold: null }, "release-1")).status).toBe(200);
    const resumed = await get<CardPage>("/cards?mode=board&view=summary");
    expect(resumed.cards.find((c) => c.id === "C-2")?.hold).toBeUndefined();
    expect(resumed.lanes?.in_progress?.held_total).toBe(0);
    expect(resumed.counts.agent).toBe(1);
    expect(
      (await get<CardPage>("/cards?overview=progress")).cards.some(
        (c) => c.id === "C-2",
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
