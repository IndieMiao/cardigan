import type { CardId, EventId } from "@cardigan/domain";
import { expect, test } from "vitest";
import type {
  ActivityData,
  CardDetail,
  CardPage,
} from "../../../web/src/api.js";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

import { readCardDetail } from "./card-state.js";
import { readNeedsState } from "./needs-state.js";
import { needsYou, projectState } from "./read.js";

const password = "pagination-test-password";

test("event cursors survive concurrent inserts and reject other projects, filters and oversized pages", async () => {
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    f.store.createProject({ id: "other" as never });
    const cookie = await f.login(password);
    const path = `/api/projects/${project_id}/activity?limit=2`;
    const first = (await call(f.port, path, { cookie })).json as ActivityData;
    expect(first.events).toHaveLength(2);
    expect(first.next_before).toBeTruthy();
    f.store.uow.run((tx) =>
      tx.events.append(project_id, {
        id: "new-concurrent-event" as EventId,
        card_id: "C-1" as CardId,
        seq: 10000,
        type: "comment_posted",
        actor: { kind: "human", project_id },
        payload: {},
        created_at: "2099-01-01T00:00:00.000Z",
      }),
    );
    const seen = first.events.map((e) => e.id);
    let cursor = first.next_before;
    for (let i = 0; cursor && i < 20; i++) {
      const response = await call(f.port, `${path}&before=${cursor}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const page = response.json as ActivityData;
      expect(page.events.length).toBeLessThanOrEqual(2);
      seen.push(...page.events.map((e) => e.id));
      cursor = page.next_before;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain("new-concurrent-event");
    const total = Number(
      f.store.database
        .prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?")
        .get(project_id)?.n,
    );
    expect(seen).toHaveLength(total - 1);
    for (const bad of [
      `/api/projects/other/activity?before=${first.next_before}`,
      `${path}&card_id=C-1&before=${first.next_before}`,
      `${path}&before=broken`,
      `/api/projects/${project_id}/activity?limit=201`,
      `/api/projects/${project_id}/cards/C-1?limit=201`,
      `/api/projects/${project_id}/execution?limit=101`,
      `/api/projects/${project_id}/cards?limit=999999`,
      `/api/projects/${project_id}/decision-history?limit=-1`,
    ])
      expect((await call(f.port, bad, { cookie })).status, bad).toBe(400);
  } finally {
    await f.close();
  }
});

test("card pages filter and sort before LIMIT, board lanes page independently, timeline windows stay bounded", async () => {
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    f.store.uow.run((tx) => {
      const source = tx.cards.get(project_id, "C-3" as CardId);
      if (!source) throw new Error("missing fixture");
      const first = tx.cards.get(project_id, "C-1" as CardId);
      if (!first) throw new Error("missing fixture");
      tx.cards.put(project_id, { ...first, goal: "See R-1 A-1 W-2 C-2" });
      const active = tx.cards.get(project_id, "C-2" as CardId);
      if (!active) throw new Error("missing fixture");
      // Legacy/stale stored status must not move this live work into the todo lane.
      tx.cards.put(project_id, { ...active, status: "todo" });
      for (let i = 4; i <= 27; i++)
        tx.cards.put(project_id, {
          ...source,
          id: `C-${i}` as CardId,
          title: `Archive ${i}`,
        });
    });
    const cookie = await f.login(password);
    const readCards = async (query: string) => {
      const response = await call(
        f.port,
        `/api/projects/${project_id}/cards?${query}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      return response.json as CardPage;
    };
    const second = await readCards("status=done&sort=id&limit=10&page=2");
    expect(second.cards.map((c) => c.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `C-${i + 13}`),
    );
    expect(second.total_filtered).toBe(25);
    const found = await readCards("q=archive%2027&limit=1");
    expect(found.cards.map((c) => c.id)).toEqual(["C-27"]);
    expect(found.total_filtered).toBe(1);
    const board = await readCards("mode=board&sort=id&limit=10");
    expect(board.lanes?.in_progress?.total).toBe(2);
    expect(board.lanes?.todo?.total).toBe(0);
    expect(
      (await readCards("status=in_progress&limit=1&page=2")).cards[0]?.id,
    ).toBe("C-2");
    expect(board.cards.filter((c) => c.status === "done")).toHaveLength(10);
    const cursor = board.lanes?.done?.next_cursor;
    expect(cursor).toBeTruthy();
    const more = await readCards(
      `mode=board&status=done&sort=id&limit=10&cursor=${cursor}`,
    );
    expect(more.cards.map((c) => c.id)).toEqual(second.cards.map((c) => c.id));
    expect(
      (
        await call(
          f.port,
          `/api/projects/${project_id}/cards?mode=board&status=todo&sort=id&cursor=${cursor}`,
          { cookie },
        )
      ).status,
    ).toBe(400);
    const first = (
      await call(f.port, `/api/projects/${project_id}/cards/C-1?limit=1`, {
        cookie,
      })
    ).json as CardDetail;
    expect(first.timeline).toHaveLength(1);
    for (const id of ["R-1", "A-1", "W-2"])
      expect(first.card.references).toContainEqual(
        expect.objectContaining({ id, exists: true, card_id: "C-2" }),
      );
    expect(first.timeline_next_cursor).toBeTruthy();
    for (const id of ["C-1", "C-2", "C-3"]) {
      const response = await call(
        f.port,
        `/api/projects/${project_id}/cards/${id}?limit=1`,
        { cookie },
      );
      const {
        project_id: _project,
        timeline_next_cursor: _cursor,
        ...detail
      } = response.json as CardDetail & { now: string };
      expect(detail).toEqual(
        readCardDetail(f.store, project_id, id as CardId, {
          timelineLimit: 1,
          now: detail.now,
        }),
      );
    }
    const older = (
      await call(
        f.port,
        `/api/projects/${project_id}/cards/C-1?limit=1&before=${first.timeline_next_cursor}`,
        { cookie },
      )
    ).json as CardDetail;
    expect(older.timeline).toHaveLength(1);
    expect(older.timeline[0]?.event_seq).toBeLessThan(
      first.timeline[0]?.event_seq ?? 0,
    );
    expect(
      (
        await call(
          f.port,
          `/api/projects/${project_id}/cards/C-2?limit=1&before=${first.timeline_next_cursor}`,
          { cookie },
        )
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});

test("narrow Needs You retains closed readiness targets and project rule epochs from the merged baseline", async () => {
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    f.store.uow.run((tx) => {
      for (const q of tx.decisions.list(project_id))
        tx.decisions.put(project_id, {
          ...q,
          ready_when: { kind: "card_merged", card_id: "C-3" as CardId },
        });
      for (const h of tx.human_actions.list(project_id))
        tx.human_actions.put(project_id, {
          ...h,
          ready_when: { kind: "card_merged", card_id: "C-3" as CardId },
        });
      tx.events.append(project_id, {
        id: "rule-epoch" as EventId,
        seq: tx.ids.nextEventSequence(project_id),
        type: "project_preferences_updated",
        actor: { kind: "human", project_id },
        payload: { preference: "system_reminders", new_value: true },
        created_at: "2026-01-01T00:00:00.000Z",
      });
    });
    const state = readNeedsState(f.store, project_id);
    expect(state.events.some((e) => e.id === "rule-epoch")).toBe(true);
    const now = "2026-01-02T00:00:00.000Z";
    expect(needsYou(state, now)).toEqual(
      needsYou(projectState(f.store, project_id), now),
    );
    expect(needsYou(state, now).later).toEqual([]);
    expect(needsYou(state, now).decisions).toHaveLength(1);
  } finally {
    await f.close();
  }
});
