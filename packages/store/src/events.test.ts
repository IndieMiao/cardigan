import { expect, test } from "vitest";
import {
  assignment,
  card,
  event,
  project_id,
  timelineEntry,
  withTempStore,
} from "./test-support.js";

function seedCard(
  store: Parameters<Parameters<typeof withTempStore>[0]>[0],
): void {
  store.uow.run((tx) => tx.cards.put(project_id, card()));
}

test("seq is contiguous and unique per card stream", () => {
  withTempStore((store) => {
    seedCard(store);
    const seqs = store.uow.run((tx) => {
      const written: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const seq = tx.ids.nextEventSequence(project_id, card().id);
        tx.events.append(project_id, event({ id: tx.ids.nextEventId(), seq }));
        written.push(seq);
      }
      return written;
    });

    expect(seqs).toEqual([1, 2, 3]);
    expect(
      store
        .getUpdates({ project_id, card_id: card().id })
        .events.map((e) => e.seq),
    ).toEqual([1, 2, 3]);
  });
});

test("card streams and the project-level stream have independent seq", () => {
  withTempStore((store) => {
    seedCard(store);
    store.uow.run((tx) => {
      const projectEvent = event({
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project_id),
      });
      tx.events.append(project_id, { ...projectEvent, card_id: undefined });
      tx.events.append(
        project_id,
        event({
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project_id, card().id),
        }),
      );
    });

    expect(store.getUpdates({ project_id }).events.map((e) => e.seq)).toEqual([
      1,
    ]);
    expect(
      store
        .getUpdates({ project_id, card_id: card().id })
        .events.map((e) => e.seq),
    ).toEqual([1]);
  });
});

test("C-634: latest seq per stream and stream counters come from one query each", () => {
  withTempStore((store) => {
    seedCard(store);
    const other = "other" as typeof project_id;
    store.createProject({ id: other });
    expect(store.latestEventSeqs(project_id)).toEqual(new Map());
    store.uow.run((tx) => {
      for (const [project, stream, count] of [
        [project_id, undefined, 2],
        [project_id, card().id, 3],
        [other, undefined, 5],
      ] as const)
        for (let i = 0; i < count; i += 1)
          tx.events.append(project, {
            ...event({
              id: tx.ids.nextEventId(),
              seq: tx.ids.nextEventSequence(project, stream),
            }),
            card_id: stream,
          });
    });
    expect(store.latestEventSeqs(project_id)).toEqual(
      new Map([
        ["", 2],
        [card().id, 3],
      ]),
    );
    expect(store.eventStreamCounters(project_id)).toEqual(
      new Map([
        ["", 2],
        [card().id, 3],
      ]),
    );
    expect(store.latestEventSeqs(other)).toEqual(new Map([["", 5]]));
    // A rolled-back append takes its counter with it.
    expect(() =>
      store.uow.run((tx) => {
        tx.events.append(project_id, {
          ...event({
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(project_id),
          }),
          card_id: undefined,
        });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.eventStreamCounters(project_id).get("")).toBe(2);
    expect(store.latestEventSeqs(project_id).get("")).toBe(2);
  });
});

test("a duplicate seq cannot be persisted", () => {
  withTempStore((store) => {
    seedCard(store);
    store.uow.run((tx) => {
      tx.events.append(project_id, event({ id: tx.ids.nextEventId(), seq: 1 }));
    });

    expect(() =>
      store.uow.run((tx) => {
        tx.events.append(
          project_id,
          event({ id: tx.ids.nextEventId(), seq: 1 }),
        );
      }),
    ).toThrow(/UNIQUE/i);
  });
});

test("get_updates returns events and timeline entries after since_seq", () => {
  withTempStore((store) => {
    seedCard(store);
    store.uow.run((tx) => {
      for (let i = 0; i < 3; i += 1) {
        const seq = tx.ids.nextEventSequence(project_id, card().id);
        tx.events.append(project_id, event({ id: tx.ids.nextEventId(), seq }));
        const entry = timelineEntry({ event_seq: seq, body: `comment ${seq}` });
        tx.timeline.put(project_id, {
          ...entry,
          id: tx.ids.nextTimelineEntryId(project_id, card().id),
        });
      }
    });

    const all = store.getUpdates({ project_id, card_id: card().id });
    expect(all.latest_seq).toBe(3);
    expect(all.events.map((e) => e.type)).toEqual([
      "comment_added",
      "comment_added",
      "comment_added",
    ]);
    expect(all.timeline.map((entry) => entry.body)).toEqual([
      "comment 1",
      "comment 2",
      "comment 3",
    ]);

    const recent = store.getUpdates({
      project_id,
      card_id: card().id,
      since_seq: 2,
    });
    expect(recent.events.map((e) => e.seq)).toEqual([3]);
    expect(recent.timeline.map((entry) => entry.event_seq)).toEqual([3]);
    expect(recent.latest_seq).toBe(3);
  });
});

test("ack_events moves the cursor forward only", () => {
  withTempStore((store) => {
    seedCard(store);
    store.uow.run((tx) => {
      for (let i = 0; i < 3; i += 1) {
        tx.events.append(
          project_id,
          event({
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(project_id, card().id),
          }),
        );
      }
      tx.assignments.put(project_id, assignment());
    });

    const ack = (up_to_seq: number) =>
      store.ackEvents({
        project_id,
        assignment_id: assignment().id,
        card_id: card().id,
        up_to_seq,
      });

    expect(ack(2)).toEqual({
      ok: true,
      value: { acked_seq: 2, changed: true },
    });
    // Repeating the same ack is a no-op, not an error (retries are normal).
    expect(ack(2)).toEqual({
      ok: true,
      value: { acked_seq: 2, changed: false },
    });
    // An older ack never moves the cursor back.
    expect(ack(1)).toEqual({
      ok: true,
      value: { acked_seq: 2, changed: false },
    });
    expect(ack(3)).toEqual({
      ok: true,
      value: { acked_seq: 3, changed: true },
    });
  });
});

test("ack_events rejects a sequence beyond the newest event", () => {
  withTempStore((store) => {
    seedCard(store);
    store.uow.run((tx) => {
      tx.assignments.put(project_id, assignment());
      tx.events.append(
        project_id,
        event({
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project_id, card().id),
        }),
      );
    });

    const result = store.ackEvents({
      project_id,
      assignment_id: assignment().id,
      card_id: card().id,
      up_to_seq: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("validation_failed");
  });
});

test("cursor rows keep one row per assignment and card", () => {
  withTempStore((store) => {
    seedCard(store);
    store.uow.run((tx) => {
      tx.assignments.put(project_id, assignment());
      tx.events.append(
        project_id,
        event({
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project_id, card().id),
        }),
      );
    });
    for (const seq of [1, 1, 1]) {
      store.ackEvents({
        project_id,
        assignment_id: assignment().id,
        card_id: card().id,
        up_to_seq: seq,
      });
    }
    const rows = store.database
      .prepare("SELECT COUNT(*) AS n FROM cursors WHERE project_id = ?")
      .get(project_id);
    expect(Number(rows?.n)).toBe(1);
  });
});
