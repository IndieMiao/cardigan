import type {
  ExecutionMachine,
  MachineBindingView,
  MachineCapabilityView,
  MachineRequirements,
  MachineSelection,
  MachineSelectionCandidate,
  MachineView,
} from "./api.js";
import { STATUS_LABELS } from "./status.js";

const BLOCKERS: Readonly<Record<string, string>> = {
  machine_check_failed: "机器检查失败",
  machine_observation_failed: "能力检查失败",
  machine_not_ready: "机器未就绪",
  machine_platform_mismatch: "OS 或架构与登记不一致",
};
/** Host blocker codes; unknown codes stay visible as-is rather than hidden. */
export function healthBlockerLabel(code: string): string {
  return BLOCKERS[code] ?? code;
}

export type HealthView = {
  readonly status: string;
  readonly label: string;
  readonly subdued: boolean;
};
/** Health is the host's latest machine check, separate from the registry status. */
export function machineHealth(machine: ExecutionMachine): HealthView {
  const health = machine.health;
  if (!health) return { status: "not_run", label: "未检查", subdued: true };
  if (health.status === "checking")
    return { status: "running", label: "检查中", subdued: false };
  if (health.status === "failed")
    return { status: "failed", label: "健康检查失败", subdued: false };
  return health.available
    ? { status: "passed", label: "健康", subdued: false }
    : { status: "inactive", label: "健康快照已过期", subdued: true };
}

export function requirementParts(
  requirements: MachineRequirements | undefined,
): string[] {
  if (!requirements) return [];
  return [
    ...(requirements.os ? [`OS ${requirements.os}`] : []),
    ...(requirements.arch ? [`架构 ${requirements.arch}`] : []),
    ...(requirements.capabilities?.length
      ? [`能力 ${requirements.capabilities.join("、")}`]
      : []),
    ...(requirements.tags?.length
      ? [`标签 ${requirements.tags.join("、")}`]
      : []),
  ];
}

/** Registry reasons are short codes (`draining`, `os=linux`, `tag=x`); the rest is already prose. */
export function exclusionReason(reason: string): string {
  if (Object.hasOwn(STATUS_LABELS, reason))
    return STATUS_LABELS[reason as keyof typeof STATUS_LABELS];
  const [key, ...rest] = reason.split("=");
  const value = rest.join("=");
  if (value && key === "os") return `需要 OS ${value}`;
  if (value && key === "arch") return `需要架构 ${value}`;
  if (value && key === "tag") return `缺少标签 ${value}`;
  return reason;
}

export type CapabilityState = NonNullable<MachineCapabilityView["state"]>;
export function capabilityState(c: MachineCapabilityView): CapabilityState {
  return c.state ?? (c.available ? "verified" : "expired");
}

/**
 * The resource slot that set the remaining ratio, when it is tighter than the
 * machine's own Agent capacity. Uses the selection-time snapshot only.
 */
function bottleneck(c: MachineSelectionCandidate) {
  const machineRatio =
    c.limit !== null && c.occupied !== null && c.limit > 0
      ? (c.limit - c.occupied) / c.limit
      : 1;
  let tightest:
    | NonNullable<MachineSelectionCandidate["resources"]>[number]
    | undefined;
  let ratio = machineRatio;
  for (const slot of c.resources ?? []) {
    if (slot.limit <= 0) continue;
    const r = (slot.limit - slot.occupied) / slot.limit;
    if (r < ratio) {
      ratio = r;
      tightest = slot;
    }
  }
  return tightest;
}

/** Why the chosen candidate ranked first, in the order the host sorted by. */
export function candidateReasons(c: MachineSelectionCandidate): string[] {
  const slot = bottleneck(c);
  const occupancy = [
    ...(slot ? [`${slot.key} 占用 ${slot.occupied}/${slot.limit}`] : []),
    ...(c.limit !== null && c.occupied !== null
      ? [`${slot ? "机器" : ""}占用 ${c.occupied}/${c.limit}`]
      : []),
    ...(c.pending_assignments ? [`其中待启动 ${c.pending_assignments}`] : []),
  ];
  return [
    ...(c.control_host ? ["验证项优先控制主机"] : []),
    ...(c.affinity ? ["同卡产出已在此机器"] : []),
    ...(c.remaining_ratio !== null
      ? [
          `剩余容量 ${Math.round(Math.max(0, c.remaining_ratio) * 100)}%${
            occupancy.length ? `（${occupancy.join("，")}）` : ""
          }`,
        ]
      : []),
    ...(c.preference_rank !== null
      ? [`项目偏好第 ${c.preference_rank + 1} 位`]
      : []),
  ];
}

export function selectionSummary(
  selection: MachineSelection,
  label: (id: string) => string = (id) => id,
): string {
  if (selection.status === "deferred")
    return `未选出机器：${selection.reason || "原因未记录"}`;
  const machine = label(selection.machine_id) || "未记录";
  if (selection.status !== "selected") return `${machine}（已分配）`;
  const chosen = selection.candidates?.find(
    (c) => c.machine_id === selection.machine_id,
  );
  const reasons = chosen ? candidateReasons(chosen) : [];
  return `${machine}（自动选择${reasons.length ? `：${reasons.join("，")}` : ""}）`;
}

/** C-512: one check record of a machine binding, as the settings page shows it. */
export interface MachineCheckRow {
  readonly key: string;
  readonly kind: string;
  readonly status: "passed" | "failed" | "running" | "unknown" | "unreadable";
  readonly label: string;
  /** Null only for a record the host could not read. */
  readonly checked_at: string | null;
  readonly steps: readonly string[];
}
const CHECK_LABELS: Readonly<Record<MachineCheckRow["status"], string>> = {
  passed: "通过",
  failed: "失败",
  running: "检查中",
  unknown: "未知",
  unreadable: "无法读取",
};
const checkRow = (
  key: string,
  kind: string,
  status: string,
  checked_at: string,
  steps: readonly string[],
): MachineCheckRow => {
  const normal =
    status === "checking" || status === "running"
      ? "running"
      : status === "passed" || status === "failed"
        ? status
        : "unknown";
  return {
    key,
    kind,
    status: normal,
    label: CHECK_LABELS[normal],
    checked_at,
    steps,
  };
};
const time = (value: string | null) => {
  const t = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/**
 * The check records of one project binding, newest first: the machine health
 * check, the worker onboarding check and the latest explicitly requested one.
 * A requested check already shown as the health or worker record is not
 * repeated. A worker record the host could not read is listed as such, never
 * as "no check"; `local` has no worker record to read.
 */
export function bindingChecks(
  binding: MachineBindingView,
  machineId: string,
): MachineCheckRow[] {
  const rows: MachineCheckRow[] = [];
  const health = binding.machine_check;
  if (health)
    rows.push(
      checkRow(
        "machine",
        "机器检查",
        health.status,
        health.checked_at,
        health.blockers.map(healthBlockerLabel),
      ),
    );
  const worker = binding.worker_check;
  if (worker)
    rows.push(
      checkRow(
        "worker",
        "接入检查",
        worker.status,
        worker.checked_at,
        worker.failed_steps,
      ),
    );
  const requested = binding.last_requested_check;
  if (requested) {
    const row = checkRow(
      "requested",
      requested.kind === "worker" ? "手动接入检查" : "手动机器检查",
      requested.status,
      requested.checked_at,
      requested.failed_steps,
    );
    if (
      !rows.some(
        (r) => r.checked_at === row.checked_at && r.status === row.status,
      )
    )
      rows.push(row);
  }
  rows.sort((a, b) => time(b.checked_at) - time(a.checked_at));
  if (!binding.worker_record_readable && machineId !== "local")
    rows.push({
      key: "worker-unreadable",
      kind: "接入检查",
      status: "unreadable",
      label: CHECK_LABELS.unreadable,
      checked_at: null,
      steps: [],
    });
  return rows;
}

/**
 * The machine's newest check across every binding the server returned, with
 * the project it belongs to (this project wins a tie). Without any dated
 * record, an unreadable one is reported rather than "never checked".
 */
export function latestMachineCheck(
  machine: MachineView,
): { check: MachineCheckRow; binding: MachineBindingView } | undefined {
  const rows = machine.bindings.flatMap((binding) =>
    bindingChecks(binding, machine.id).map((check) => ({ check, binding })),
  );
  const dated = rows
    .filter((r) => r.check.checked_at !== null)
    .sort(
      (a, b) =>
        time(b.check.checked_at) - time(a.check.checked_at) ||
        Number(b.binding.is_current) - Number(a.binding.is_current),
    );
  return dated[0] ?? rows[0];
}

/**
 * Every active Run on the machine across the projects it serves, including
 * the standing sessions the Agent limit exempts; it matches the running-task
 * list, not the limited count.
 */
export function machineActiveRuns(machine: MachineView): number {
  return machine.bindings.reduce(
    (sum, b) => sum + b.assignments.reduce((n, a) => n + a.runs.length, 0),
    0,
  );
}
