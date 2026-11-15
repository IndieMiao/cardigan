import type { DatabaseSync } from "node:sqlite";
import type { SnapshotTransaction } from "./command-snapshots.js";
import {
  createGlobalRepositories,
  type ReadGlobalRepositories,
} from "./employees.js";
import { ReadOnlyTransactionError } from "./read-only.js";
import { snapshotTables } from "./snapshot-migration.js";
import { prepare } from "./statements.js";

export { ReadOnlyTransactionError } from "./read-only.js";

import type {
  Assignment,
  AssignmentId,
  Attachment,
  AttachmentId,
  Card,
  CardId,
  CardTemplate,
  Cursor,
  Decision,
  DecisionId,
  Delivery,
  DeliveryId,
  Event,
  EventRepository,
  HumanAction,
  HumanActionId,
  Machine,
  MachineId,
  ProjectId,
  ProjectPreferences,
  Repositories,
  Repository,
  Review,
  ReviewId,
  RoleReference,
  Run,
  RunId,
  TimelineEntry,
  TimelineEntryId,
  WorkItem,
  WorkItemId,
} from "@cardigan/domain";

export type SqlValue = string | number | null;

/** A repository as seen from `uow.read`: reads only. */
export type ReadRepository<Entity, Key> = Pick<
  Repository<Entity, Key>,
  "get" | "list"
>;

export type ReadEventRepository = Pick<EventRepository, "listAfter"> & {
  /** Optional bulk history reader supplied by Store's transaction cache. */
  listStreams?(project: ProjectId): ReadonlyMap<string, readonly Event[]>;
};

/** Everything `uow.read` hands to its callback. */
export interface ReadRepositories extends ReadGlobalRepositories {
  readonly test_review_trust?: import("@cardigan/domain").TestReviewTrust;
  readonly cachedCommandState?: SnapshotTransaction["state"];
  readonly project_preferences: ReadRepository<ProjectPreferences, ProjectId>;
  readonly card_templates: ReadRepository<
    CardTemplate,
    Pick<CardTemplate, "id" | "version">
  >;
  readonly cards: ReadRepository<Card, CardId>;
  readonly work_items: ReadRepository<WorkItem, WorkItemId>;
  readonly assignments: ReadRepository<Assignment, AssignmentId>;
  readonly runs: ReadRepository<Run, RunId>;
  readonly timeline: ReadRepository<TimelineEntry, TimelineEntryId>;
  readonly deliveries: ReadRepository<Delivery, DeliveryId>;
  readonly reviews: ReadRepository<Review, ReviewId>;
  readonly decisions: ReadRepository<Decision, DecisionId>;
  readonly human_actions: ReadRepository<HumanAction, HumanActionId>;
  readonly attachments: ReadRepository<Attachment, AttachmentId>;
  readonly roles: ReadRepository<
    RoleReference,
    Pick<RoleReference, "role_id" | "role_version">
  >;
  readonly machines: ReadRepository<Machine, MachineId>;
  readonly cursors: ReadRepository<
    Cursor,
    Pick<Cursor, "assignment_id" | "card_id">
  >;
  readonly events: ReadEventRepository;
}

export interface TableSpec<Entity> {
  readonly table: string;
  /** Primary-key columns, in order, after project_id. */
  readonly key: readonly string[];
  /** Every stored column, in the order `values` returns them. */
  readonly columns: readonly string[];
  readonly values: (entity: Entity) => readonly SqlValue[];
}

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ");

/**
 * Repository over a table that keeps its key columns plus a `doc` column with
 * the canonical JSON entity.
 */
export function jsonRepository<Entity, Key>(
  db: DatabaseSync,
  spec: TableSpec<Entity>,
  mode: "read" | "write" = "write",
): Repository<Entity, Key> {
  const keyMatch = spec.key.map((column) => `${column} = ?`).join(" AND ");
  const selectByKey = prepare(
    db,
    `SELECT doc FROM ${spec.table} WHERE project_id = ? AND ${keyMatch}`,
  );
  const selectAll = prepare(
    db,
    `SELECT doc FROM ${spec.table} WHERE project_id = ?`,
  );
  const updates = spec.columns
    .filter((column) => !spec.key.includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .concat("doc = excluded.doc")
    .join(", ");
  const upsert =
    mode === "write"
      ? prepare(
          db,
          `INSERT INTO ${spec.table} (project_id, ${spec.columns.join(", ")}, doc) ` +
            `VALUES (?, ${placeholders(spec.columns.length)}, ?) ` +
            `ON CONFLICT (project_id, ${spec.key.join(", ")}) DO UPDATE SET ${updates}`,
        )
      : undefined;

  const decode = (row: unknown): Entity =>
    JSON.parse((row as { doc: string }).doc) as Entity;

  return {
    get: (project_id, key) => {
      const row = selectByKey.get(project_id, ...keyColumns(key, spec.key));
      return row === undefined ? undefined : decode(row);
    },
    list: (project_id) => selectAll.all(project_id).map(decode),
    put: (project_id, entity) => {
      if (upsert === undefined) {
        throw new ReadOnlyTransactionError(`${spec.table}.put`);
      }
      upsert.run(project_id, ...spec.values(entity), JSON.stringify(entity));
    },
  };
}

/**
 * Key values in column order. The domain key is either a primitive or an
 * object of the key columns; `undefined` marks a missing key column, which
 * SQLite stores as NULL (and never matches another row).
 */
function keyColumns(
  key: unknown,
  columns: readonly string[],
): readonly SqlValue[] {
  if (typeof key === "string" || typeof key === "number" || key === null) {
    return [key];
  }
  const record = key as Record<string, unknown>;
  return columns.map((column) => {
    const value = record[column];
    return typeof value === "string" || typeof value === "number"
      ? value
      : null;
  });
}

/** Event store: per-stream monotonic seq, enforced by a unique index. */
export function eventRepository(
  db: DatabaseSync,
  mode: "read" | "write" = "write",
): EventRepository {
  const insert =
    mode === "write"
      ? prepare(
          db,
          "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
      : undefined;
  const after = prepare(
    db,
    "SELECT doc FROM events WHERE project_id = ? AND stream = ? AND seq > ? ORDER BY seq",
  );

  return {
    append: (project_id, event) => {
      if (insert === undefined) {
        throw new ReadOnlyTransactionError("events.append");
      }
      insert.run(
        project_id,
        event.id,
        event.card_id ?? null,
        event.card_id ?? "",
        event.seq,
        event.type,
        JSON.stringify(event),
      );
    },
    listAfter: (project_id, card_id, since_seq) =>
      after
        .all(project_id, card_id ?? "", since_seq)
        .map((row) => JSON.parse((row as { doc: string }).doc) as Event),
  };
}

const cardSpec: TableSpec<Card> = {
  table: "cards",
  key: ["id"],
  columns: ["id"],
  values: (card) => [card.id],
};
const workItemSpec: TableSpec<WorkItem> = {
  table: "work_items",
  key: ["id"],
  columns: ["id", "card_id"],
  values: (item) => [item.id, item.card_id],
};
const assignmentSpec: TableSpec<Assignment> = {
  table: "assignments",
  key: ["id"],
  columns: ["id", "machine_id", "mcp_token_id"],
  values: (assignment) => [
    assignment.id,
    assignment.machine_id,
    assignment.mcp_token_id,
  ],
};
const runSpec: TableSpec<Run> = {
  table: "runs",
  key: ["id"],
  columns: ["id", "assignment_id", "trigger_event_id"],
  values: (run) => [run.id, run.assignment_id, run.trigger_event_id],
};
const timelineSpec: TableSpec<TimelineEntry> = {
  table: "timeline",
  key: ["id"],
  columns: ["id", "card_id", "event_seq"],
  values: (entry) => [entry.id, entry.card_id, entry.event_seq],
};
const deliverySpec: TableSpec<Delivery> = {
  table: "deliveries",
  key: ["id"],
  columns: ["id", "work_item_id"],
  values: (delivery) => [delivery.id, delivery.work_item_id],
};
const reviewSpec: TableSpec<Review> = {
  table: "reviews",
  key: ["id"],
  columns: ["id", "delivery_id"],
  values: (review) => [review.id, review.delivery_id],
};
const decisionSpec: TableSpec<Decision> = {
  table: "decisions",
  key: ["id"],
  columns: ["id"],
  values: (decision) => [decision.id],
};
const humanActionSpec: TableSpec<HumanAction> = {
  table: "human_actions",
  key: ["id"],
  columns: ["id"],
  values: (action) => [action.id],
};
const attachmentSpec: TableSpec<Attachment> = {
  table: "attachments",
  key: ["id"],
  columns: ["id", "sha256"],
  values: (attachment) => [attachment.id, attachment.sha256],
};
const roleSpec: TableSpec<RoleReference> = {
  table: "roles",
  key: ["role_id", "role_version"],
  columns: ["role_id", "role_version"],
  values: (role) => [role.role_id, role.role_version],
};
const machineSpec: TableSpec<Machine> = {
  table: "machines",
  key: ["id"],
  columns: ["id"],
  values: (machine) => [machine.id],
};
const cursorSpec: TableSpec<Cursor> = {
  table: "cursors",
  key: ["assignment_id", "card_id"],
  columns: ["assignment_id", "card_id", "acked_seq"],
  values: (cursor) => [cursor.assignment_id, cursor.card_id, cursor.acked_seq],
};

/** Write-capable repositories of one connection (inside `uow.run`). */
export function createRepositories(
  db: DatabaseSync,
  snapshots?: SnapshotTransaction,
): Repositories {
  return snapshotRepositories(baseRepositories(db, "write"), snapshots);
}

/** Read-only repositories of one connection (inside `uow.read`). */
export function createReadRepositories(
  db: DatabaseSync,
  snapshots?: SnapshotTransaction,
): ReadRepositories {
  return {
    ...snapshotRepositories(baseRepositories(db, "read"), snapshots),
    ...createGlobalRepositories(db, "read", snapshots),
  };
}

const repositories = new WeakMap<
  DatabaseSync,
  Partial<Record<"read" | "write", Repositories>>
>();
function baseRepositories(
  db: DatabaseSync,
  mode: "read" | "write",
): Repositories {
  let modes = repositories.get(db);
  if (!modes) {
    modes = {};
    repositories.set(db, modes);
  }
  const existing = modes[mode];
  if (existing) return existing;
  const created = create(db, mode);
  modes[mode] = created;
  return created;
}

/** Each transaction gets its own snapshot readers; prepared repositories are reusable. */
function snapshotRepositories(
  base: Repositories,
  snapshots?: SnapshotTransaction,
): Repositories {
  if (!snapshots) return base;
  return Object.fromEntries(
    Object.entries(base).map(([table, repository]) => {
      const keys = snapshotTables[table];
      return [
        table,
        keys && table !== "events"
          ? {
              ...repository,
              list: (project: ProjectId) =>
                snapshots.list(table, keys, project),
            }
          : repository,
      ];
    }),
  ) as unknown as Repositories;
}

/** Migrations may add repositories that were unavailable in an old schema. */
export function clearRepositoryCache(db: DatabaseSync): void {
  repositories.delete(db);
}

function create(db: DatabaseSync, mode: "read" | "write"): Repositories {
  return {
    project_preferences: preferenceRepository(db, mode),
    card_templates: templateRepository(db, mode),
    cards: jsonRepository<Card, CardId>(db, cardSpec, mode),
    work_items: jsonRepository<WorkItem, WorkItemId>(db, workItemSpec, mode),
    assignments: jsonRepository<Assignment, AssignmentId>(
      db,
      assignmentSpec,
      mode,
    ),
    runs: jsonRepository<Run, RunId>(db, runSpec, mode),
    timeline: jsonRepository<TimelineEntry, TimelineEntryId>(
      db,
      timelineSpec,
      mode,
    ),
    deliveries: jsonRepository<Delivery, DeliveryId>(db, deliverySpec, mode),
    reviews: jsonRepository<Review, ReviewId>(db, reviewSpec, mode),
    decisions: jsonRepository<Decision, DecisionId>(db, decisionSpec, mode),
    human_actions: jsonRepository<HumanAction, HumanActionId>(
      db,
      humanActionSpec,
      mode,
    ),
    attachments: jsonRepository<Attachment, AttachmentId>(
      db,
      attachmentSpec,
      mode,
    ),
    roles: jsonRepository<
      RoleReference,
      Pick<RoleReference, "role_id" | "role_version">
    >(db, roleSpec, mode),
    machines: jsonRepository<Machine, MachineId>(db, machineSpec, mode),
    cursors: jsonRepository<Cursor, Pick<Cursor, "assignment_id" | "card_id">>(
      db,
      cursorSpec,
      mode,
    ),
    events: eventRepository(db, mode),
  };
}

function templateRepository(
  db: DatabaseSync,
  mode: "read" | "write",
): Repository<CardTemplate, Pick<CardTemplate, "id" | "version">> {
  // Historical migration fixtures may open a pre-template schema.
  if (
    !prepare(
      db,
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_templates'",
    ).get()
  )
    return {
      get: () => undefined,
      list: () => [],
      put: () => {
        throw new Error("Card template migration is required");
      },
    };
  const repository = jsonRepository<
    CardTemplate,
    { template_id: string; version: number }
  >(
    db,
    {
      table: "card_templates",
      key: ["template_id", "version"],
      columns: ["template_id", "version"],
      values: (t) => [t.id, t.version],
    },
    mode,
  );
  return {
    ...repository,
    get: (project, key) =>
      repository.get(project, { template_id: key.id, version: key.version }),
  };
}

function preferenceRepository(
  db: DatabaseSync,
  mode: "read" | "write",
): Repository<ProjectPreferences, ProjectId> {
  // Historical migration fixtures deliberately open older schemas.
  if (
    !prepare(
      db,
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_preferences'",
    ).get()
  )
    return {
      get: () => undefined,
      list: () => [],
      put: () => {
        throw new Error("Project preferences migration is required");
      },
    };
  return jsonRepository(
    db,
    {
      table: "project_preferences",
      key: ["id"],
      columns: ["id"],
      values: (p: ProjectPreferences) => [p.id],
    },
    mode,
  );
}
