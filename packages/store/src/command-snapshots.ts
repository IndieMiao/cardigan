import type { DatabaseSync } from "node:sqlite";
import type { CommandState, ProjectId } from "@cardigan/domain";
import { prepare } from "./statements.js";

type Cached<T> = { version: string; value: T };
type Rows = {
  entities: ReadonlyMap<string, unknown>;
  list: readonly unknown[];
};

/** A Store owns the committed cache. Transaction-local copies never escape rollback. */
export class CommandSnapshots {
  private readonly committed = new Map<string, Cached<unknown>>();
  constructor(private readonly db: DatabaseSync) {}

  version(project: ProjectId): string {
    // The empty project contains global identities and employee activity only.
    // Inbox, token, idempotency and other projects' writes do not invalidate it.
    return JSON.stringify(
      prepare(
        this.db,
        `SELECT project_id, collection, version
      FROM command_versions WHERE project_id IN ('', ?) ORDER BY project_id, collection`,
      ).all(project),
    );
  }

  transaction(): SnapshotTransaction {
    const db = this.db;
    const pending = new Map<string, Cached<unknown>>();
    const memo = <T>(
      key: string,
      version: string,
      build: (previous?: Cached<T>) => T,
    ): T => {
      const previous = (pending.get(key) ?? this.committed.get(key)) as
        | Cached<T>
        | undefined;
      if (previous?.version === version) return previous.value;
      const value = build(previous);
      pending.set(key, { version, value });
      return value;
    };
    const revision = (table: string, project: string) =>
      String(
        prepare(
          db,
          "SELECT version FROM command_versions WHERE project_id = ? AND collection = ?",
        ).get(project, table)?.version ?? 0,
      );
    return {
      state: (project, build) =>
        memo(`state:${project}`, this.version(project), () => build()),
      global: (tables, build) =>
        memo(
          `global:${JSON.stringify(tables)}`,
          (typeof tables === "string" ? [tables] : tables)
            .map((t) => revision(t, ""))
            .join(":"),
          () => build(),
        ),
      list: <T>(
        table: string,
        keys: readonly string[],
        project: ProjectId,
      ): readonly T[] => {
        const key = `rows:${table}:${project}`;
        const version = revision(table, project);
        const snapshot = memo<Rows>(key, version, (previous) => {
          const entityKey = `json_array(${keys.map((k) => `t.${k}`).join(",")})`;
          const entities = new Map(previous?.value.entities);
          if (!previous) {
            for (const row of prepare(
              db,
              `SELECT ${entityKey} AS entity_key, doc FROM ${table} t WHERE project_id = ?`,
            ).all(project))
              entities.set(String(row.entity_key), JSON.parse(String(row.doc)));
            return { entities, list: [...entities.values()] };
          }
          const match = keys
            .map((k, i) => `t.${k} = json_extract(c.entity_key, '$[${i}]')`)
            .join(" AND ");
          for (const row of prepare(
            db,
            `SELECT c.entity_key, t.doc FROM command_rows c
            LEFT JOIN ${table} t ON t.project_id = c.project_id AND ${match}
            WHERE c.project_id = ? AND c.collection = ? AND c.version > ?`,
          ).all(project, table, previous.version)) {
            const key = String(row.entity_key);
            if (row.doc === null) entities.delete(key);
            else entities.set(key, JSON.parse(String(row.doc)));
          }
          // Preserve the repository's SQLite iteration order, including composite
          // keys and timeline indexes. Touch doc without transferring/decoding it
          // so SQLite uses the same non-covering plan as SELECT doc.
          const list = prepare(
            db,
            `SELECT ${entityKey} AS entity_key, typeof(doc) FROM ${table} t WHERE project_id = ?`,
          )
            .all(project)
            .map((row) => entities.get(String(row.entity_key)));
          return { entities, list };
        });
        return snapshot.list as readonly T[];
      },
      commit: () => {
        for (const [key, value] of pending) this.committed.set(key, value);
      },
    };
  }
}

export interface SnapshotTransaction {
  state(project: ProjectId, build: () => CommandState): CommandState;
  global<T>(table: string | readonly string[], build: () => T): T;
  list<T>(
    table: string,
    keys: readonly string[],
    project: ProjectId,
  ): readonly T[];
  commit(): void;
}
