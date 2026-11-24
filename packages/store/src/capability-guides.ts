import {
  type Actor,
  authorizeCapabilityGuideWrite,
  type CapabilityGuideEntry,
  type CapabilityGuideTarget,
  type DomainError,
  type MergedCapabilityGuides,
  mergeCapabilityGuides,
  validateCapabilityGuideTarget,
  validateUsageNote,
} from "@cardigan/domain";
import type { Store } from "./store.js";

/**
 * C-725: rows of `capability_guides`, the usage notes of the machine
 * capability catalog. Separate from `machine_capabilities`: probes, health
 * and placement never read or write this table, and nothing here touches
 * theirs. Every write runs the domain rules first, so an Agent actor or a
 * credential-like note never reaches SQLite.
 */
export class CapabilityGuideError extends Error {
  readonly code: DomainError["code"];
  constructor(error: DomainError) {
    super(error.message);
    this.name = "CapabilityGuideError";
    this.code = error.code;
  }
}

type Row = Record<string, unknown>;

function entryOf(row: Row): CapabilityGuideEntry {
  const scope = String(row.scope) as CapabilityGuideEntry["scope"];
  return {
    scope,
    key: String(row.key),
    machine_id: scope === "machine" ? String(row.machine_id) : null,
    usage_note: String(row.usage_note),
    updated_at: String(row.updated_at),
    updated_by: row.updated_by === "system" ? "system" : "human",
  };
}

function checked<T>(
  result: { ok: true; value: T } | { ok: false; error: DomainError },
): T {
  if (!result.ok) throw new CapabilityGuideError(result.error);
  return result.value;
}

function writable(store: Store, actor: Actor, project: string) {
  const writer = checked(authorizeCapabilityGuideWrite(actor, project));
  if (!store.getProject(project))
    throw new CapabilityGuideError({
      code: "not_found",
      message: "项目不存在",
    });
  return writer;
}

/** Every entry of a project, ordered by scope, key and machine. */
export function listCapabilityGuides(
  store: Store,
  project: string,
): CapabilityGuideEntry[] {
  return store.uow.read(() =>
    (
      store.database
        .prepare(
          "SELECT scope, key, machine_id, usage_note, updated_at, updated_by FROM capability_guides WHERE project_id = ? ORDER BY scope, key, machine_id",
        )
        .all(project) as Row[]
    ).map(entryOf),
  );
}

/** The project's notes merged for one machine (see `mergeCapabilityGuides`). */
export function readCapabilityGuides(
  store: Store,
  project: string,
  options: {
    readonly machine_id?: string | null;
    readonly capabilities?: readonly string[];
  } = {},
): MergedCapabilityGuides {
  return mergeCapabilityGuides(listCapabilityGuides(store, project), options);
}

/** Create or replace one entry. Humans and the host only. */
export function setCapabilityGuide(
  store: Store,
  actor: Actor,
  project: string,
  target: unknown,
  usage_note: unknown,
  now: string,
): CapabilityGuideEntry {
  const writer = writable(store, actor, project);
  const parsed: CapabilityGuideTarget = checked(
    validateCapabilityGuideTarget(target),
  );
  const note = checked(validateUsageNote(usage_note));
  store.uow.run(() => {
    store.database
      .prepare(
        "INSERT INTO capability_guides VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, scope, key, machine_id) DO UPDATE SET usage_note = excluded.usage_note, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      )
      .run(
        project,
        parsed.scope,
        parsed.key,
        parsed.machine_id ?? "",
        note,
        now,
        writer,
      );
  });
  return { ...parsed, usage_note: note, updated_at: now, updated_by: writer };
}

/** Remove one entry; false when it did not exist. Humans and the host only. */
export function deleteCapabilityGuide(
  store: Store,
  actor: Actor,
  project: string,
  target: unknown,
): boolean {
  writable(store, actor, project);
  const parsed = checked(validateCapabilityGuideTarget(target));
  return store.uow.run(
    () =>
      store.database
        .prepare(
          "DELETE FROM capability_guides WHERE project_id = ? AND scope = ? AND key = ? AND machine_id = ?",
        )
        .run(project, parsed.scope, parsed.key, parsed.machine_id ?? "")
        .changes === 1,
  );
}
