import type {
  ExecutionMachine,
  MachineRequirements,
  MachineSelection,
  MachineSelectionCandidate,
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

/** Why the chosen candidate ranked first, in the order the host sorted by. */
export function candidateReasons(c: MachineSelectionCandidate): string[] {
  return [
    ...(c.control_host ? ["验证项优先控制主机"] : []),
    ...(c.affinity ? ["同卡产出已在此机器"] : []),
    ...(c.remaining_ratio !== null
      ? [
          `剩余容量 ${Math.round(Math.max(0, c.remaining_ratio) * 100)}%${
            c.limit !== null && c.occupied !== null
              ? `（占用 ${c.occupied}/${c.limit}）`
              : ""
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
  if (selection.status === "explicit") return `${machine}（指定机器）`;
  const chosen = selection.candidates?.find(
    (c) => c.machine_id === selection.machine_id,
  );
  const reasons = chosen ? candidateReasons(chosen) : [];
  return `${machine}（自动选择${reasons.length ? `：${reasons.join("，")}` : ""}）`;
}
