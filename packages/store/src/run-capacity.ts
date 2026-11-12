import type { DatabaseSync } from "node:sqlite";
import type {
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
