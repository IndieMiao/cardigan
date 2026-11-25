import type { Store } from "@cardigan/store";
import { capacityMachine, capacityOwnerState } from "./capacity-owner.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

/**
 * C-390: the human-only host maintenance window. Stored in `host_maintenance`
 * (one row). Lives under the `deployment-` prefix because the deployment
 * supervisor and check admission read the gate (see supervisor scope).
 */
export const MAINTENANCE_PHASES = [
  "draining",
  "drain_timeout",
  "stopping",
  "stopped",
  "operating",
  "starting",
  "rolling_back",
  "recovery_required",
  "completed",
  "abandoned",
  "rolled_back",
] as const;
export type MaintenancePhase = (typeof MAINTENANCE_PHASES)[number];
/** Terminal phases lift the gate; every other phase keeps new work out. */
export const MAINTENANCE_TERMINAL: readonly MaintenancePhase[] = [
  "completed",
  "abandoned",
  "rolled_back",
];

export type MaintenanceOperation =
  | { readonly kind: "manual" }
  | { readonly kind: "command"; readonly argv: readonly string[] }
  | {
      readonly kind: "hc_upgrade";
      readonly version: string;
      readonly targets: readonly string[];
    };

export interface MaintenanceBusyItem {
  readonly kind: "run" | "check" | "operation" | "deployment";
  readonly id: string;
  readonly project_id?: string;
  readonly card_id?: string;
  readonly status?: string;
  readonly label?: string;
}

/** How one hc link looked before an upgrade switched it (the recovery point). */
export type HcLinkState =
  | { readonly kind: "symlink"; readonly target: string }
  | { readonly kind: "file"; readonly backup: string };

export interface MaintenanceRecord {
  readonly id: string;
  readonly reason: string;
  readonly operation: MaintenanceOperation;
  /** hc targets this window stops and starts again. */
  readonly stop_hc: readonly string[];
  readonly started_at: string;
  readonly wait: {
    readonly timeout_ms: number;
    readonly deadline: string;
    /** The human chose to go on although these items had not finished. */
    readonly proceeded?: {
      readonly at: string;
      readonly items: readonly MaintenanceBusyItem[];
    };
  };
  /** Recorded before anything changes; restored and compared at the end. */
  readonly before: {
    readonly software_sha: string | null;
    readonly server_process: string | null;
    readonly deploy_pin: string | null;
    readonly hc: Readonly<Record<string, string | null>>;
  };
  /** Declared before execution: what a failure can put back automatically. */
  readonly rollback_scope: string;
  readonly steps: {
    readonly server_stopped?: boolean;
    readonly hc_stopped?: readonly string[];
    /** Per hc target: its link before the switch. */
    readonly switched?: Readonly<Record<string, HcLinkState>>;
    readonly operation?: "done" | "failed";
  };
  /** Last observation of unfinished work. */
  readonly busy: readonly MaintenanceBusyItem[];
  readonly error?: string;
  /** Present while the gate stays closed after a failed restore. */
  readonly recovery?: readonly string[];
  readonly history: readonly {
    readonly at: string;
    readonly phase: MaintenancePhase;
    readonly note: string;
  }[];
}

export interface MaintenanceRow {
  readonly phase: MaintenancePhase;
  readonly record: MaintenanceRecord;
  readonly revision: number;
  /** A live CLI process is driving a step right now. */
  readonly held: boolean;
}

export class MaintenanceUnavailable extends Error {
  constructor() {
    super(
      "当前数据库还没有维护表：请先部署含维护命令的版本（由运行中的 server 执行迁移）后再试",
    );
  }
}
export class MaintenanceConflict extends Error {
  constructor(
    message = "维护状态已被另一个命令改变，请用 maintenance status 查看后重试",
  ) {
    super(message);
  }
}

const HISTORY_LIMIT = 100;

/** Never throws: an older schema or an unreadable row means no gate. */
export function maintenanceActive(store: Pick<Store, "database">): boolean {
  try {
    const row = store.database
      .prepare("SELECT phase FROM host_maintenance WHERE singleton = 1")
      .get() as { phase: string } | undefined;
    return (
      !!row && !MAINTENANCE_TERMINAL.includes(row.phase as MaintenancePhase)
    );
  } catch {
    return false;
  }
}

function tableExists(store: Store): boolean {
  return !!store.database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'host_maintenance'",
    )
    .get();
}

export function readMaintenance(store: Store): MaintenanceRow | undefined {
  if (!tableExists(store)) throw new MaintenanceUnavailable();
  const row = store.database
    .prepare("SELECT * FROM host_maintenance WHERE singleton = 1")
    .get() as
    | {
        phase: string;
        record: string;
        revision: number | bigint;
        holder_pid: number | bigint | null;
        holder_start: string | null;
        holder_machine: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!MAINTENANCE_PHASES.includes(row.phase as MaintenancePhase))
    throw new Error("维护记录阶段无效，请人工核对 host_maintenance");
  return {
    phase: row.phase as MaintenancePhase,
    record: JSON.parse(row.record) as MaintenanceRecord,
    revision: Number(row.revision),
    held:
      row.holder_pid !== null &&
      row.holder_start !== null &&
      capacityOwnerState({
        owner_pid: row.holder_pid,
        owner_start: row.holder_start,
        owner_machine: row.holder_machine,
      }) !== "dead",
  };
}

export function withHistory(
  record: MaintenanceRecord,
  phase: MaintenancePhase,
  note: string,
  at: string,
): MaintenanceRecord {
  return {
    ...record,
    history: [...record.history, { at, phase, note }].slice(-HISTORY_LIMIT),
  };
}

function owner(): ExecutionOwner {
  const self = executionOwner(process.pid);
  if (!self) throw new Error("无法确认本进程身份，维护命令未执行");
  return self;
}

/** Start a window. Refuses while another one is still open. */
export function createMaintenance(
  store: Store,
  record: MaintenanceRecord,
  at: string,
): MaintenanceRow {
  const self = owner();
  return store.uow.run(() => {
    const current = readMaintenance(store);
    if (current && !MAINTENANCE_TERMINAL.includes(current.phase))
      throw new MaintenanceConflict(
        `已有未结束的维护 ${current.record.id}（${current.phase}），请先 maintenance status 查看`,
      );
    store.database
      .prepare(`INSERT OR REPLACE INTO host_maintenance
        (singleton, id, phase, record, revision, holder_pid, holder_start, holder_machine, updated_at)
        VALUES (1, ?, 'draining', ?, 1, ?, ?, ?, ?)`)
      .run(
        record.id,
        JSON.stringify(record),
        self.pid,
        self.start,
        capacityMachine(),
        at,
      );
    return { phase: "draining", record, revision: 1, held: true };
  });
}

/** Take over a window for this process; refuses while a live CLI drives it. */
export function claimMaintenance(store: Store, at: string): MaintenanceRow {
  const self = owner();
  return store.uow.run(() => {
    const current = readMaintenance(store);
    if (!current) throw new MaintenanceConflict("当前没有维护");
    const row = store.database
      .prepare(
        "SELECT holder_pid, holder_start FROM host_maintenance WHERE singleton = 1",
      )
      .get() as { holder_pid: unknown; holder_start: unknown };
    const mine =
      Number(row.holder_pid) === self.pid && row.holder_start === self.start;
    if (current.held && !mine)
      throw new MaintenanceConflict(
        "另一个维护命令正在执行这次维护，请等它结束后再操作",
      );
    store.database
      .prepare(`UPDATE host_maintenance SET holder_pid = ?, holder_start = ?,
        holder_machine = ?, revision = revision + 1, updated_at = ? WHERE singleton = 1`)
      .run(self.pid, self.start, capacityMachine(), at);
    return { ...current, revision: current.revision + 1, held: true };
  });
}

/** Compare-and-set one transition. Terminal phases also drop the holder. */
export function updateMaintenance(
  store: Store,
  previous: MaintenanceRow,
  phase: MaintenancePhase,
  record: MaintenanceRecord,
  at: string,
): MaintenanceRow {
  return store.uow.run(() => {
    const changed = store.database
      .prepare(`UPDATE host_maintenance SET phase = ?, record = ?, revision = revision + 1,
        updated_at = ? WHERE singleton = 1 AND id = ? AND revision = ?`)
      .run(phase, JSON.stringify(record), at, record.id, previous.revision);
    if (Number(changed.changes) !== 1) throw new MaintenanceConflict();
    return { phase, record, revision: previous.revision + 1, held: true };
  });
}

/** Leave the window for the next command; never throws. */
export function releaseMaintenanceHolder(store: Store): void {
  const self = executionOwner(process.pid);
  if (!self) return;
  try {
    store.uow.run(() => {
      store.database
        .prepare(`UPDATE host_maintenance SET holder_pid = NULL, holder_start = NULL,
          holder_machine = NULL WHERE singleton = 1 AND holder_pid = ? AND holder_start = ?`)
        .run(self.pid, self.start);
    });
  } catch {
    /* A dead holder never blocks the next command. */
  }
}
