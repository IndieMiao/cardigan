import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardId, EventId } from "@cardigan/domain";
import { setProjectPreferences } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { mergeFixture } from "../../../../packages/domain/src/commands/merge/test-fixtures.js";
import { human } from "../../../../packages/domain/src/commands/test-fixtures.js";
import {
  NOW,
  project_id,
  seedWebProject,
} from "../../test-support/web-data.js";
import { readCardDetail, readCardList } from "./card-state.js";
import { cardDetail, cardListViews, projectState } from "./read.js";

test("card reads equal the full snapshot, preserve cross-card links and upload dates, and see fresh changes", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-card-state-"));
  const store = Store.open({ dbPath: ":memory:" });
  const firstId = "C-1" as CardId;
  const secondId = "C-2" as CardId;
  try {
    seedWebProject(store, root);
    store.database
      .prepare(
        "UPDATE attachments SET doc = json_remove(doc, '$.card_id') WHERE project_id = ? AND id = ?",
      )
      .run(project_id, "F-2");
    store.uow.run((tx) => {
      tx.project_preferences.put(project_id, {
        id: project_id,
        auto_merge_after_minutes: 10,
      });
      const first = tx.cards.get(project_id, firstId);
      const entry = tx.timeline
        .list(project_id)
        .find((e) => e.card_id === "C-2");
      const attachment = tx.attachments.list(project_id)[0];
      if (!first || !entry || !attachment) throw new Error("Missing fixture");
      tx.cards.put(project_id, {
        ...first,
        goal: `See ${entry.id} C-2 C-9 W-2 A-1`,
        related_cards: [secondId],
      });
      tx.attachments.put(project_id, { ...attachment, card_id: secondId });
      tx.events.append(project_id, {
        id: "upload-elsewhere" as EventId,
        card_id: secondId,
        seq: 1000,
        type: "attachment_uploaded",
        actor: { kind: "human", project_id },
        payload: { attachment_id: attachment.id },
        created_at: "2026-02-01T00:00:00.000Z",
      });
    });
    const check = () => {
      const full = projectState(store, project_id);
      expect(readCardList(store, project_id)).toEqual(cardListViews(full));
      for (const card of full.cards) {
        for (const options of [
          { now: NOW },
          { now: NOW, timelineLimit: 1 },
          { now: NOW, timelineLimit: 1, timelineAnchor: "entry-C-1#1" },
        ])
          expect(readCardDetail(store, project_id, card.id, options)).toEqual(
            cardDetail(full, card.id, options),
          );
      }
      expect(
        readCardDetail(store, project_id, "C-999" as CardId),
      ).toBeUndefined();
    };
    check();
    expect(
      readCardList(store, project_id).find((card) => card.id === firstId)
        ?.attachment_count,
    ).toBe(2);
    // Rebuild the indexes over populated v12 data, as an existing installation
    // does. They must preserve timestamps and be maintained by later writes.
    store.database.exec(
      "DROP INDEX events_by_card_updated_at; DROP INDEX events_by_type; DELETE FROM schema_version WHERE version = 13",
    );
    expect(
      store.database
        .prepare("SELECT name FROM schema_version WHERE version = 12")
        .get()?.name,
    ).toBe("project_preferences");
    expect(store.migrate()).toEqual([{ version: 13, name: "card_reads" }]);
    expect(store.migrate()).toEqual([]);
    expect(
      store.uow.read((tx) =>
        tx.project_preferences.get(project_id, project_id),
      ),
    ).toMatchObject({ auto_merge_after_minutes: 10 });
    check();
    store.uow.run((tx) => {
      const card = tx.cards.get(project_id, firstId);
      if (!card) throw new Error("Missing fixture");
      tx.cards.put(project_id, { ...card, title: "Changed without an event" });
      tx.events.append(project_id, {
        id: "later" as EventId,
        card_id: firstId,
        seq: 1001,
        type: "card_updated",
        actor: { kind: "human", project_id },
        payload: {},
        created_at: "2027-01-01T00:00:00.000Z",
      });
    });
    check();
    expect(readCardList(store, project_id)[0]).toMatchObject({
      title: "Changed without an event",
      updated_at: "2027-01-01T00:00:00.000Z",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("narrow reads retain baseline merge checks and automatic merge schedules across cards", async () => {
  const f = mergeFixture();
  await f.accept();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 10 },
      f.io,
    ),
  );
  const store = Store.open({ dbPath: ":memory:" });
  const project = f.state.project_id;
  const otherCard = "C-2" as CardId;
  try {
    store.createProject({ id: project });
    store.uow.run((tx) => {
      for (const card of f.state.cards) tx.cards.put(project, card);
      tx.cards.put(project, { ...f.card, id: otherCard });
      for (const item of f.state.work_items) tx.work_items.put(project, item);
      for (const assignment of f.state.assignments)
        tx.assignments.put(project, assignment);
      for (const run of f.state.runs) tx.runs.put(project, run);
      for (const delivery of f.state.deliveries)
        tx.deliveries.put(project, delivery);
      for (const review of f.state.reviews) tx.reviews.put(project, review);
      for (const decision of f.state.decisions)
        tx.decisions.put(project, { ...decision, affected_cards: [otherCard] });
      for (const preference of f.state.project_preferences ?? [])
        tx.project_preferences.put(project, preference);
      for (const entry of f.state.timeline) tx.timeline.put(project, entry);
      for (const event of f.state.events) tx.events.append(project, event);
      const completion = f.state.deliveries.find(
        (d) => d.kind === "card_completion",
      );
      if (!completion) throw new Error("Missing completion fixture");
      tx.events.append(project, {
        id: "check-started" as EventId,
        card_id: f.card.id,
        seq:
          Math.max(
            ...f.state.events
              .filter((e) => e.card_id === f.card.id)
              .map((e) => e.seq),
          ) + 1,
        type: "merge_check_started",
        actor: { kind: "system", project_id: project },
        payload: { completion_id: completion.id, status: "running" },
        created_at: NOW,
      });
    });
    const full = projectState(store, project);
    const cards = readCardList(store, project);
    expect(cards).toEqual(cardListViews(full));
    expect(cards[0]).toMatchObject({ merge_check: { status: "running" } });
    for (const id of [f.card.id, otherCard]) {
      const detail = readCardDetail(store, project, id, { now: NOW });
      expect(detail).toEqual(cardDetail(full, id, { now: NOW }));
      expect(detail?.decisions[0]?.auto_merge).toMatchObject({ minutes: 10 });
    }
  } finally {
    store.close();
  }
});
