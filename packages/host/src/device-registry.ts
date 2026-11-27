import {
  type DeviceObservation,
  type DeviceRegistration,
  type DeviceRegistrationRequest,
  type DeviceRegistrationStatus,
  deviceInitProject,
  deviceRegistrationNext,
  validateDeviceProjects,
} from "@cardigan/domain";
import { readMachineObservations, type Store } from "@cardigan/store";

/**
 * C-817: the host's record of external devices a person has seen, enabled
 * or disabled (`machine_devices`, across projects like the C-813 leases).
 *
 * Only `enabled` devices assigned to a project are handed to its Runs. The
 * table never touches leases: disabling, reassigning or losing a device
 * leaves a live lease to the C-813 release rules, so a device a Run holds is
 * never handed to a second Run.
 */
interface Row {
  machine: string;
  type: string;
  device: string;
  status: DeviceRegistrationStatus;
  projects: string;
  model: string | null;
  version: string | null;
  resolution: string | null;
  init_project: string | null;
  init_started_at: string | null;
  failure: string | null;
  discovered_at: string;
  updated_at: string;
  initialized_at: string | null;
}

/** A claimed initialization that has not reported back within this is retried. */
export const DEVICE_INIT_CLAIM_MS = 2 * 60 * 1000;

export class DeviceRequestError extends Error {
  constructor(
    readonly code: "device_not_found" | "device_request_invalid",
    message: string,
  ) {
    super(message);
  }
}

function hasTable(store: Store) {
  return !!store.database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_devices'",
    )
    .get();
}

function registration(row: Row): DeviceRegistration {
  let projects: string[] = [];
  try {
    const value = JSON.parse(row.projects);
    if (Array.isArray(value))
      projects = value.filter((p): p is string => typeof p === "string");
  } catch {
    projects = [];
  }
  return {
    machine: row.machine,
    type: row.type,
    id: row.device,
    status: row.status,
    projects,
    ...(row.model ? { model: row.model } : {}),
    ...(row.version ? { version: row.version } : {}),
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.init_project ? { init_project: row.init_project } : {}),
    ...(row.failure ? { failure: row.failure } : {}),
    discovered_at: row.discovered_at,
    updated_at: row.updated_at,
    ...(row.initialized_at ? { initialized_at: row.initialized_at } : {}),
  };
}

/** Projects registering this machine id, in id order. */
export function machineProjects(store: Store, machine: string) {
  return store.uow.read((tx) =>
    store
      .listProjects()
      .map((p) => p.id)
      .filter((p) => !!tx.machines.get(p, machine))
      .sort(),
  );
}

export class DeviceRegistry {
  constructor(private readonly store: Store) {}

  get(machine: string, type: string, id: string) {
    if (!hasTable(this.store)) return undefined;
    const row = this.store.database
      .prepare(
        "SELECT * FROM machine_devices WHERE machine=? AND type=? AND device=?",
      )
      .get(machine, type, id) as Row | undefined;
    return row && registration(row);
  }

  list(machine?: string): DeviceRegistration[] {
    if (!hasTable(this.store)) return [];
    const rows = (
      machine === undefined
        ? this.store.database
            .prepare(
              "SELECT * FROM machine_devices ORDER BY machine, type, device",
            )
            .all()
        : this.store.database
            .prepare(
              "SELECT * FROM machine_devices WHERE machine=? ORDER BY type, device",
            )
            .all(machine)
    ) as unknown as Row[];
    return rows.map(registration);
  }

  /**
   * A listing saw this device. An available device never seen before is
   * registered as `pending` (and returned); a known one only refreshes its
   * model when the listing has one.
   */
  discover(machine: string, device: DeviceObservation, now: string) {
    if (!hasTable(this.store)) return undefined;
    if (device.model)
      this.store.database
        .prepare(
          "UPDATE machine_devices SET model=? WHERE machine=? AND type=? AND device=? AND (model IS NULL OR model<>?)",
        )
        .run(device.model, machine, device.type, device.id, device.model);
    if (device.state !== "available") return undefined;
    const inserted = this.store.database
      .prepare(
        "INSERT OR IGNORE INTO machine_devices (machine,type,device,status,projects,model,discovered_at,updated_at) VALUES (?,?,?,'pending','[]',?,?,?)",
      )
      .run(machine, device.type, device.id, device.model ?? null, now, now);
    return inserted.changes ? this.get(machine, device.type, device.id) : undefined;
  }

  /**
   * A person's request (Needs You or the host CLI). `enable` and `assign`
   * need the projects (all registering the machine); the initialization runs
   * as the first of them whose latest check sees the device available.
   */
  request(input: {
    machine: string;
    type: string;
    id: string;
    request: DeviceRegistrationRequest;
    projects?: readonly string[];
    now: string;
  }): DeviceRegistration {
    const current = this.get(input.machine, input.type, input.id);
    if (!current)
      throw new DeviceRequestError(
        "device_not_found",
        "机器上没有登记这台设备",
      );
    const next = deviceRegistrationNext(current, input.request);
    if ("error" in next)
      throw new DeviceRequestError("device_request_invalid", next.error);
    let projects = current.projects;
    if (input.request !== "disable") {
      const allowed = machineProjects(this.store, input.machine);
      const checked = validateDeviceProjects(
        input.projects ?? current.projects,
        allowed,
      );
      if ("error" in checked)
        throw new DeviceRequestError("device_request_invalid", checked.error);
      projects = checked.projects;
    }
    const init =
      next.status === "initializing"
        ? deviceInitProject(projects, (project) =>
            (
              readMachineObservations(
                this.store,
                project,
                input.machine,
                input.now,
              ).health?.devices ?? []
            ).some(
              (d) =>
                d.type === input.type &&
                d.id === input.id &&
                d.state === "available",
            ),
          )
        : current.init_project;
    this.store.database
      .prepare(
        "UPDATE machine_devices SET status=?, projects=?, init_project=?, init_started_at=NULL, failure=CASE WHEN ?='initializing' THEN NULL ELSE failure END, updated_at=? WHERE machine=? AND type=? AND device=?",
      )
      .run(
        next.status,
        JSON.stringify(projects),
        init ?? null,
        next.status,
        input.now,
        input.machine,
        input.type,
        input.id,
      );
    return this.get(input.machine, input.type, input.id) as DeviceRegistration;
  }

  /**
   * Claim the initialization of a device this project's check should run.
   * Returns the claim, or `undefined` when nothing is due (another check
   * runs it, it was disabled meanwhile, or another project runs it).
   */
  claimInit(
    machine: string,
    type: string,
    id: string,
    project: string,
    now: string,
  ) {
    if (!hasTable(this.store)) return undefined;
    const stale = new Date(Date.parse(now) - DEVICE_INIT_CLAIM_MS).toISOString();
    const claimed = this.store.database
      .prepare(
        "UPDATE machine_devices SET init_started_at=? WHERE machine=? AND type=? AND device=? AND status='initializing' AND init_project=? AND (init_started_at IS NULL OR init_started_at<?)",
      )
      .run(now, machine, type, id, project, stale);
    return claimed.changes ? now : undefined;
  }

  /** Record a claimed initialization's outcome; a newer request wins. */
  finishInit(
    machine: string,
    type: string,
    id: string,
    claim: string,
    outcome:
      | { ok: true; resolution?: string; version?: string }
      | { ok: false; reason: string },
    now: string,
  ) {
    const changed = this.store.database
      .prepare(
        outcome.ok
          ? "UPDATE machine_devices SET status='enabled', init_started_at=NULL, failure=NULL, resolution=COALESCE(?,resolution), version=COALESCE(?,version), initialized_at=?, updated_at=? WHERE machine=? AND type=? AND device=? AND status='initializing' AND init_started_at=?"
          : "UPDATE machine_devices SET status='failed', init_started_at=NULL, failure=?, updated_at=? WHERE machine=? AND type=? AND device=? AND status='initializing' AND init_started_at=?",
      )
      .run(
        ...(outcome.ok
          ? [
              outcome.resolution ?? null,
              outcome.version ?? null,
              now,
              now,
              machine,
              type,
              id,
              claim,
            ]
          : [outcome.reason, now, machine, type, id, claim]),
      );
    return changed.changes > 0;
  }

  /** Devices whose initialization this project's checks run, not yet claimed (or stale). */
  dueInits(now: string) {
    const stale = new Date(Date.parse(now) - DEVICE_INIT_CLAIM_MS).toISOString();
    return this.list().filter(
      (d) =>
        d.status === "initializing" &&
        !!d.init_project &&
        !this.claimedSince(d, stale),
    );
  }

  private claimedSince(d: DeviceRegistration, stale: string) {
    const row = this.store.database
      .prepare(
        "SELECT init_started_at FROM machine_devices WHERE machine=? AND type=? AND device=?",
      )
      .get(d.machine, d.type, d.id) as { init_started_at: string | null };
    return !!row?.init_started_at && row.init_started_at >= stale;
  }
}
