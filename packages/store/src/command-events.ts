import type { DatabaseSync } from "node:sqlite";
import type { Event, ProjectId } from "@cardigan/domain";

type Snapshot = {
  through: number;
  streams: ReadonlyMap<string, readonly Event[]>;
};

/** Events are append-only. Keep decoded history, but publish it only on COMMIT. */
export class CommandEvents {
  private committed = new Map<ProjectId, Snapshot>();

  transaction(db: DatabaseSync) {
    const pending = new Map<ProjectId, Snapshot>();
    return {
      listStreams: (
        project: ProjectId,
      ): ReadonlyMap<string, readonly Event[]> => {
        const through = Number(
          (
            db
              .prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM events")
              .get() as { n: number }
          ).n,
        );
        const previous = pending.get(project) ?? this.committed.get(project);
        if (previous?.through === through) return previous.streams;
        const streams = new Map(previous?.streams);
        const rows = db
          .prepare(
            "SELECT doc FROM events NOT INDEXED WHERE rowid > ? AND rowid <= ? AND project_id = ? ORDER BY rowid",
          )
          .all(previous?.through ?? 0, through, project);
        const added = new Map<string, Event[]>();
        for (const row of rows) {
          const event = JSON.parse(row.doc as string) as Event;
          const key = event.card_id ?? "";
          let events = added.get(key);
          if (!events) {
            events = [];
            added.set(key, events);
          }
          events.push(event);
        }
        for (const [key, events] of added)
          streams.set(
            key,
            [...(streams.get(key) ?? []), ...events].sort(
              (a, b) => a.seq - b.seq,
            ),
          );
        pending.set(project, { through, streams });
        return streams;
      },
      commit: () => {
        for (const [project, snapshot] of pending)
          this.committed.set(project, snapshot);
      },
    };
  }
}
