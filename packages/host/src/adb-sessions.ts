import type { Assignment, DeviceHolder } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import type { AdbSlotPolicy } from "./adb-slots.js";

/**
 * C-833: sessions launched before a machine switched its adb environment.
 *
 * A session keeps the environment it was launched with across wakes. When a
 * machine starts handing out adb slots (C-679) or USB devices through them
 * (C-813), a session launched before has no slot port and no `ADB_USB=0`;
 * a script of it that starts an adb server on a fixed port then claims the
 * USB devices. Each launch records the machine's adb environment (no ports);
 * a live session whose recorded environment differs from the current one is
 * replaced at its next wake (dispatch `resource_isolation`), without a person.
 *
 * Sessions launched before this record existed are judged from what the
 * database shows about the machine at their launch: some adb slot row
 * (slots were configured) and, when the machine now hands out devices, some
 * device lease. Without that evidence the session counts as launched before.
 */
type Config = { adbSlots(machine: string): AdbSlotPolicy | undefined };

export interface StaleAdbSession {
  readonly project: string;
  readonly assignment_id: Assignment["id"];
}

function hasTable(store: Store, name: string) {
  return !!store.database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

export class AdbSessionEnvironments {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    /** adb device types the machine's slots hand out (`DeviceLeases.adbTypes`). */
    private readonly usbTypes: (machine: string) => readonly string[],
  ) {}
  /** The machine's current adb launch environment; undefined: not managed. */
  environment(machine: string) {
    if (!this.config.adbSlots(machine)) return undefined;
    return JSON.stringify({
      slots: true,
      usb: [...this.usbTypes(machine)].sort(),
    });
  }
  /** At launch compilation: this Run's session gets the current environment. */
  record(project: string, machine: string, run: string, now: string) {
    if (!hasTable(this.store, "machine_adb_launches")) return;
    this.store.database
      .prepare(
        "INSERT INTO machine_adb_launches (project,run_id,machine,environment,launched_at) VALUES (?,?,?,?,?) ON CONFLICT(project,run_id) DO UPDATE SET machine=excluded.machine, environment=excluded.environment, launched_at=excluded.launched_at",
      )
      .run(project, run, machine, this.environment(machine) ?? "none", now);
  }
  /** The live session of `a` was launched with another adb environment. */
  stale(project: string, a: Assignment) {
    const current = this.environment(a.machine_id);
    const ref = a.runtime_ref;
    if (!current || !ref || a.external || ref.machine_id !== a.machine_id)
      return false;
    const launch = ref.launch_generation?.run_id;
    if (!launch) return true;
    const row = hasTable(this.store, "machine_adb_launches")
      ? (this.store.database
          .prepare(
            "SELECT machine, environment FROM machine_adb_launches WHERE project=? AND run_id=?",
          )
          .get(project, launch) as
          | { machine: string; environment: string }
          | undefined)
      : undefined;
    if (row) return row.machine !== a.machine_id || row.environment !== current;
    return !this.inferred(project, a.machine_id, launch);
  }
  /** No record: whether the machine already had today's environment then. */
  private inferred(project: string, machine: string, run: string) {
    // Raw reads: callers may hold a unit of work (no nested one).
    const started = (
      this.store.database
        .prepare(
          "SELECT json_extract(doc,'$.started_at') AS started FROM runs WHERE project_id=? AND id=?",
        )
        .get(project, run) as { started: string | null } | undefined
    )?.started;
    if (!started) return false;
    const before = (table: string) =>
      hasTable(this.store, table) &&
      !!this.store.database
        .prepare(
          `SELECT 1 FROM ${table} WHERE machine=? AND acquired_at<=? LIMIT 1`,
        )
        .get(machine, started);
    return (
      before("machine_adb_slots") &&
      (!this.usbTypes(machine).length || before("machine_device_leases"))
    );
  }
  /** Live sessions on the machine (any project) launched before the switch. */
  staleSessions(machine: string): StaleAdbSession[] {
    const rows: StaleAdbSession[] = [];
    for (const { id: project } of this.store.listProjects())
      for (const a of this.store.uow.read((tx) => tx.assignments.list(project)))
        if (
          a.machine_id === machine &&
          a.status === "active" &&
          a.runtime_ref &&
          this.stale(project, a)
        )
          rows.push({ project, assignment_id: a.id });
    return rows;
  }
}

/** A session as people read it: `<code>-A-n`, or `<project>/A-n` without a code. */
export function sessionLabel(store: Store, project: string, id: string) {
  const code = store.projectCode(project);
  return code ? `${code}-${id}` : `${project}/${id}`;
}

/** The default port of an adb client without any configuration. */
const DEFAULT_ADB_PORT = 5037;

/**
 * C-833: the adb servers that may hold a device on this machine, for an
 * initialization that does not see it: every live Run slot's server (its
 * session), the configured legacy ports (sessions launched before the
 * switch) and the default port. No IO beyond the database.
 */
export function adbServerHolders(
  store: Store,
  config: Config,
  machine: string,
  usbTypes: (machine: string) => readonly string[],
): DeviceHolder[] {
  const policy = config.adbSlots(machine);
  const holders: DeviceHolder[] = [];
  if (policy) {
    const rows = hasTable(store, "machine_adb_slots")
      ? (store.database
          .prepare(
            "SELECT adb_port, project, assignment_id FROM machine_adb_slots WHERE machine=? AND released_at IS NULL AND purpose='run' ORDER BY slot",
          )
          .all(machine) as {
          adb_port: number;
          project: string;
          assignment_id: string | null;
        }[])
      : [];
    for (const row of rows)
      holders.push({
        port: row.adb_port,
        kind: "slot",
        sessions: row.assignment_id
          ? [sessionLabel(store, row.project, row.assignment_id)]
          : [],
      });
    const stale = new AdbSessionEnvironments(store, config, usbTypes)
      .staleSessions(machine)
      .map((s) => sessionLabel(store, s.project, s.assignment_id));
    for (const port of policy.legacyAdbPorts)
      holders.push({ port, kind: "legacy", sessions: stale });
  }
  if (!holders.some((h) => h.port === DEFAULT_ADB_PORT))
    holders.push({ port: DEFAULT_ADB_PORT, kind: "other", sessions: [] });
  return holders;
}
