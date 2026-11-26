import type { DatabaseSync } from "node:sqlite";
import type {
  CapacityOverride,
  CapacityOverrideEffect,
  GlobalRepositories,
  RunLimitEffect,
  RunLimitSetting,
} from "@cardigan/domain";
import { prepare } from "./statements.js";

/** Called inside the scheduler's claim transaction; never cached across ticks. */
export function readRunLimit(
  db: DatabaseSync,
  machine: string,
): RunLimitSetting | undefined {
  const row = prepare(
    db,
    "SELECT doc FROM run_capacity_limits WHERE machine_id = ?",
  ).get(machine);
  return row ? (JSON.parse(String(row.doc)) as RunLimitSetting) : undefined;
}

/** The caller's write transaction commits the setting and its immutable audit together. */
export function persistRunLimitEffect(
  db: DatabaseSync,
  tx: GlobalRepositories,
  effect: RunLimitEffect,
): void {
  prepare(
    db,
    "INSERT INTO run_capacity_limits (machine_id, doc) VALUES (?, ?) ON CONFLICT(machine_id) DO UPDATE SET doc = excluded.doc",
  ).run(effect.setting.machine_id, JSON.stringify(effect.setting));
  tx.global_events.append(effect.event);
}

/** C-792: read on every capacity decision, like the run limit; never cached across ticks. */
export function readCapacityOverride(
  db: DatabaseSync,
  machine: string,
): CapacityOverride | undefined {
  const text = readCapacityOverrideText(db, machine);
  return text === undefined
    ? undefined
    : (JSON.parse(text) as CapacityOverride);
}

/** C-792: the raw row text, so callers can reuse a parse while it is unchanged. */
export function readCapacityOverrideText(
  db: DatabaseSync,
  machine: string,
): string | undefined {
  const row = prepare(
    db,
    "SELECT doc FROM run_capacity_overrides WHERE machine_id = ?",
  ).get(machine);
  return row ? String(row.doc) : undefined;
}

/** C-792: the caller's write transaction commits the override and its audit together. */
export function persistCapacityOverrideEffect(
  db: DatabaseSync,
  tx: GlobalRepositories,
  machine: string,
  effect: CapacityOverrideEffect,
): void {
  if (effect.override)
    prepare(
      db,
      "INSERT INTO run_capacity_overrides (machine_id, doc) VALUES (?, ?) ON CONFLICT(machine_id) DO UPDATE SET doc = excluded.doc",
    ).run(machine, JSON.stringify(effect.override));
  else
    prepare(db, "DELETE FROM run_capacity_overrides WHERE machine_id = ?").run(
      machine,
    );
  tx.global_events.append(effect.event);
}
