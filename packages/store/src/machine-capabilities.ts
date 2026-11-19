import type { Actor } from "@cardigan/domain";
import type { Store } from "./store.js";

export const MACHINE_OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;
export interface MachineCapability {
  readonly key: string;
  readonly version: string | null;
  readonly verified_at: string;
  readonly evidence_ref: string;
}
export interface MachineHealth {
  readonly status: "checking" | "passed" | "failed";
  readonly checked_at: string;
  readonly blockers: readonly string[];
  readonly launch_enabled: boolean;
}
function systemOnly(actor: Actor, project: string): void {
  if (actor.kind !== "system" || actor.project_id !== project)
    throw new Error("Machine observations require the project system actor");
}
function fresh(at: string, now: string): boolean {
  const age = Date.parse(now) - Date.parse(at);
  return age >= 0 && age <= MACHINE_OBSERVATION_TTL_MS;
}
function decodeHealth(doc: string) {
  const { target_fingerprint, ...health } = JSON.parse(doc) as MachineHealth & {
    target_fingerprint?: string;
  };
  return { fingerprint: target_fingerprint, health };
}
export function readMachineObservations(
  store: Store,
  project: string,
  machine: string,
  now = new Date().toISOString(),
) {
  return store.uow.read(() =>
    readMachineObservationsInTransaction(store, project, machine, now),
  );
}

/** Reuse the caller's assignment transaction; never cache TTL-derived availability. */
export function readMachineObservationsInTransaction(
  store: Store,
  project: string,
  machine: string,
  now: string,
  expectedFingerprint?: string,
) {
  const row = store.database
    .prepare(
      "SELECT observation_id, doc FROM machine_health WHERE project_id = ? AND machine_id = ?",
    )
    .get(project, machine);
  const observed = row ? decodeHealth(String(row.doc)) : undefined;
  const health = observed?.health;
  const capabilities = store.database
    .prepare(
      "SELECT key, version, verified_at, evidence_ref FROM machine_capabilities WHERE project_id = ? AND machine_id = ? ORDER BY key",
    )
    .all(project, machine)
    .map((row) => {
      const capability: MachineCapability = {
        key: String(row.key),
        version: row.version === null ? null : String(row.version),
        verified_at: String(row.verified_at),
        evidence_ref: String(row.evidence_ref),
      };
      return { ...capability, available: fresh(capability.verified_at, now) };
    });
  return {
    ...(expectedFingerprint
      ? {
          observation_target_matches:
            expectedFingerprint === observed?.fingerprint,
        }
      : {}),
    capabilities,
    health: health
      ? {
          ...health,
          evidence_ref: `machine-observation:${String(row?.observation_id)}`,
          available:
            health.status === "passed" && fresh(health.checked_at, now),
        }
      : null,
  };
}

/** Fence concurrent CLI/background refreshes before IO; failed checks revoke old proof. */
export function beginMachineObservation(
  store: Store,
  actor: Actor,
  project: string,
  machine: string,
  observation: string,
  now: string,
): void {
  systemOnly(actor, project);
  store.uow.run((tx) => {
    if (!tx.machines.get(project, machine))
      throw new Error("Machine unregistered");
    store.database
      .prepare(
        "INSERT INTO machine_health VALUES (?, ?, ?, ?) ON CONFLICT(project_id, machine_id) DO UPDATE SET observation_id = excluded.observation_id, doc = excluded.doc",
      )
      .run(
        project,
        machine,
        observation,
        JSON.stringify({
          status: "checking",
          checked_at: now,
          blockers: [],
          launch_enabled: false,
        } satisfies MachineHealth),
      );
    store.database
      .prepare(
        "DELETE FROM machine_capabilities WHERE project_id = ? AND machine_id = ?",
      )
      .run(project, machine);
  });
}

/** No Agent-facing command/effect writes these tables. Only the current host probe may publish. */
export function completeMachineObservation(
  store: Store,
  actor: Actor,
  project: string,
  machine: string,
  observation: string,
  health: MachineHealth,
  capabilities: readonly MachineCapability[],
  targetFingerprint?: string,
): boolean {
  systemOnly(actor, project);
  return store.uow.run(() => {
    const updated = store.database
      .prepare(
        "UPDATE machine_health SET doc = ? WHERE project_id = ? AND machine_id = ? AND observation_id = ? AND json_extract(doc, '$.status') = 'checking'",
      )
      .run(
        JSON.stringify({ ...health, target_fingerprint: targetFingerprint }),
        project,
        machine,
        observation,
      );
    if (updated.changes !== 1) return false;
    const insert = store.database.prepare(
      "INSERT INTO machine_capabilities VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const c of capabilities)
      insert.run(
        project,
        machine,
        c.key,
        c.version,
        c.verified_at,
        c.evidence_ref,
      );
    return true;
  });
}
