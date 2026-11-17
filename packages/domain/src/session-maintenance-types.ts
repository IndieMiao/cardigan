export const SESSION_IDLE_MINUTES = 60;
export const sessionMaintenanceReasons = {
  standing: "常驻会话不参与空闲维护",
  external: "外接会话不参与空闲维护",
  inactive: "身份已暂停或释放",
  closed: "工作项已关闭或负责人已变更",
  stopped: "等待人工恢复",
  held: "卡片已暂停",
  retirement_pending: "等待确认会话退出",
  retirement_timeout: "终止超时，保留会话等待重试",
  retirement_unavailable: "未核：正常终止能力或进程身份不可用",
  run_busy: "等待未结束的执行",
  operation_pending: "等待会话操作结束",
  no_session: "没有终端会话",
  recent_activity: "尚未达到空闲候选时长",
  activity_unknown: "未核：缺少有效活动时间",
  identity_unproven: "未核：终端代次不完整",
  unsupported_capability: "当前运行时不支持会话回收",
  idle_candidate: "等待核验并回收空闲会话",
  terminal_busy: "等待终端结束工作",
  observation_incomplete: "未核：终端活动观测不完整",
  runtime_unavailable: "未核：运行环境不可用",
  maintenance_locked: "等待接入或维护操作结束",
  publication_pending: "等待角色包发布一致",
  role_conflict: "角色规则存在手改冲突",
  upgrade_pending: "等待角色升级收尾",
  upgrade_capacity: "等待角色维护名额",
  exited: "终端已退出",
  stale: "状态已变，等待重新评估",
} as const;
export type SessionMaintenanceReason = keyof typeof sessionMaintenanceReasons;
/** Routine observations remain queryable in details, without crowding attention. */
export function sessionMaintenanceNeedsAttention(
  reason: SessionMaintenanceReason,
) {
  return ![
    "standing",
    "external",
    "inactive",
    "closed",
    "stopped",
    "held",
    "run_busy",
    "no_session",
    "recent_activity",
  ].includes(reason);
}
export interface SessionMaintenanceView {
  readonly reason: SessionMaintenanceReason;
  /** Control-plane candidate only; never permission to stop a live process. */
  readonly candidate: boolean;
  readonly threshold_minutes: number;
  readonly evaluated_at: string;
  readonly since: string;
}
export interface SessionMaintenance extends SessionMaintenanceView {
  /** Internal binding; never included in diagnostic responses or events. */
  readonly basis: string;
  /** Stable session identity for cause/notice deduplication; absent in older observations. */
  readonly session_basis?: string;
  readonly notice_sent?: boolean;
}
