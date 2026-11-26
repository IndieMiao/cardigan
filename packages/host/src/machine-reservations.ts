import type { Actor, JsonValue } from "@cardigan/domain";
import type { Store, StoreTransactionContext } from "@cardigan/store";

/**
 * C-800: a calendar reservation as other projects may see it. Only these
 * metadata cross projects: never the holder's cards, Assignments or Runs.
 */
export type ReservationSource = "human" | "standing_pm" | "unknown";
export interface MachineReservation {
  readonly reservation_id: string;
  readonly machine: string;
  readonly resource: string;
  readonly holder_project: string;
  readonly source: ReservationSource;
  readonly starts_at: string;
  readonly ends_at: string;
}
/** Why a Run waits: another project's reservation, plain capacity, or another resource policy. */
export type ResourceWaitKind = "reservation" | "capacity" | "resource";
export interface ResourceWaitView {
  readonly kind: ResourceWaitKind;
  readonly reason: string;
  readonly reservation?: MachineReservation;
}

export const CAPACITY_WAIT_REASON = "并发额度或排队顺序";
export const RESERVATION_SOURCE_LABELS: Readonly<
  Record<ReservationSource, string>
> = {
  human: "人工预约",
  standing_pm: "常驻 PM 预约",
  unknown: "来源未登记",
};

type Database = Store["database"];
type Row = Record<string, unknown>;

const sourceOf = (value: unknown): ReservationSource =>
  value === "human" || value === "standing_pm" ? value : "unknown";

export function reservationOf(row: Row): MachineReservation {
  return {
    reservation_id: String(row.generation),
    machine: String(row.machine),
    resource: String(row.resource),
    holder_project: String(row.project),
    source: sourceOf(row.source),
    starts_at: String(row.starts_at),
    ends_at: String(row.ends_at),
  };
}

/** The wait reason stored and shown for a Run held back by another project's reservation. */
export function reservationReason(key: string, r: MachineReservation): string {
  return `${key}：预约独占（持有项目 ${r.holder_project}，${RESERVATION_SOURCE_LABELS[r.source]}，${r.starts_at} — ${r.ends_at}，预约 ${r.reservation_id}）`;
}

const RESERVATION_REASON = /：预约独占（[^）]*，预约 ([^，）\s]+)）$/u;

/** The reservation named by a reason produced by `reservationReason`. */
export function reservationIdOf(reason: string): string | undefined {
  return RESERVATION_REASON.exec(reason)?.[1];
}

const COLUMNS = "generation,machine,resource,project,source,starts_at,ends_at";

/** Current and future calendar reservations (not Run holds), oldest first. */
export function listMachineReservations(
  db: Database,
  options: { readonly now: string; readonly machine?: string | undefined },
): MachineReservation[] {
  const rows = options.machine
    ? db
        .prepare(
          `SELECT ${COLUMNS} FROM machine_resource_leases WHERE run_id IS NULL AND ends_at>? AND deadline_recorded IS NULL AND machine=? ORDER BY starts_at,generation`,
        )
        .all(options.now, options.machine)
    : db
        .prepare(
          `SELECT ${COLUMNS} FROM machine_resource_leases WHERE run_id IS NULL AND ends_at>? AND deadline_recorded IS NULL ORDER BY machine,starts_at,generation`,
        )
        .all(options.now);
  return rows.map((row) => reservationOf(row as Row));
}

export function findMachineReservation(
  db: Database,
  id: string,
): MachineReservation | undefined {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM machine_resource_leases WHERE generation=? AND run_id IS NULL`,
    )
    .get(id);
  return row ? reservationOf(row as Row) : undefined;
}

/** This project's resource waits by Run, with the blocking reservation's metadata. */
export function resourceWaits(
  db: Database,
  project: string,
): Map<string, ResourceWaitView> {
  const waits = new Map<string, ResourceWaitView>();
  for (const row of db
    .prepare(
      "SELECT run_id,reason,kind,reservation FROM machine_resource_waits WHERE project=? ORDER BY run_id",
    )
    .all(project)) {
    const reservation =
      typeof row.reservation === "string"
        ? findMachineReservation(db, row.reservation)
        : undefined;
    const kind = String(row.kind);
    waits.set(String(row.run_id), {
      kind: kind === "reservation" || kind === "resource" ? kind : "capacity",
      reason: String(row.reason),
      ...(reservation ? { reservation } : {}),
    });
  }
  return waits;
}

export const RESERVATION_CANCEL_REASON_MAX = 500;

function appendEvent(
  tx: StoreTransactionContext,
  actor: Actor,
  type: string,
  at: string,
  payload: JsonValue,
) {
  const project = actor.project_id;
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project),
    actor,
    type,
    created_at: at,
    payload,
  });
}

/**
 * C-800: a human ends a calendar reservation early. The window closes now; a
 * physical hold still needs the normal release proof before anyone else gets
 * it. Runs waiting on this reservation lose their wait record, so the next
 * dispatcher pass re-admits them in their original queue order.
 */
export function cancelMachineReservation(
  store: Store,
  actor: Actor,
  input: {
    readonly reservation_id: string;
    readonly reason: string;
    /** When set, the reservation must be on this machine and the machine registered in the actor's project. */
    readonly machine?: string;
  },
  now: () => string,
  /** Rechecked inside the write transaction (e.g. the Workbench owner session). */
  authorize?: (tx: StoreTransactionContext) => void,
): { reservation: MachineReservation; released_runs: number } {
  if (actor.kind !== "human") throw new Error("仅限人取消预约");
  const reason = input.reason.trim();
  if (!reason || reason.length > RESERVATION_CANCEL_REASON_MAX)
    throw new Error(
      `取消原因必填，且不超过 ${RESERVATION_CANCEL_REASON_MAX} 字`,
    );
  return store.uow.run((tx) => {
    authorize?.(tx);
    const db = store.database;
    const at = now();
    const row = db
      .prepare(
        "SELECT * FROM machine_resource_leases WHERE generation=? AND run_id IS NULL",
      )
      .get(input.reservation_id) as Row | undefined;
    if (
      !row ||
      (input.machine !== undefined &&
        (row.machine !== input.machine ||
          !tx.machines.get(actor.project_id, input.machine)))
    )
      throw new Error("预约不存在");
    const reservation = reservationOf(row);
    if (row.deadline_recorded || reservation.ends_at <= at)
      throw new Error("预约已结束");
    if (
      !db
        .prepare(
          "UPDATE machine_resource_leases SET ends_at=?, deadline_recorded=?, cancelled_at=? WHERE generation=? AND run_id IS NULL AND deadline_recorded IS NULL AND ends_at>?",
        )
        .run(at, at, at, reservation.reservation_id, at).changes
    )
      throw new Error("预约已结束");
    const waiting = db
      .prepare(
        "SELECT project,run_id FROM machine_resource_waits WHERE reservation=? ORDER BY project,run_id",
      )
      .all(reservation.reservation_id)
      .map((w) => ({ project: String(w.project), run_id: String(w.run_id) }));
    db.prepare("DELETE FROM machine_resource_waits WHERE reservation=?").run(
      reservation.reservation_id,
    );
    const base = {
      reservation_id: reservation.reservation_id,
      machine: reservation.machine,
      resource: reservation.resource,
      holder_project: reservation.holder_project,
      source: reservation.source,
      starts_at: reservation.starts_at,
      ends_at: reservation.ends_at,
      cancelled_at: at,
    };
    appendEvent(
      tx,
      { kind: "human", project_id: reservation.holder_project },
      "machine_resource_reservation_cancelled",
      at,
      {
        ...base,
        reason,
        physical_release: row.binding ? "pending" : "not_applicable",
        run_ids: waiting
          .filter((w) => w.project === reservation.holder_project)
          .map((w) => w.run_id),
      },
    );
    // Blocked projects learn only the metadata, never the human's free text.
    for (const project of new Set(waiting.map((w) => w.project)))
      if (project !== reservation.holder_project)
        appendEvent(
          tx,
          { kind: "system", project_id: project },
          "machine_resource_reservation_cancelled",
          at,
          {
            ...base,
            run_ids: waiting
              .filter((w) => w.project === project)
              .map((w) => w.run_id),
          },
        );
    return { reservation, released_runs: waiting.length };
  });
}
