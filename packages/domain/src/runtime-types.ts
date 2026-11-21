export const runtimeErrorCodes = [
  "runtime_not_found",
  "runtime_unavailable",
  "version_mismatch",
  "runtime_timeout",
  "runtime_queue_timeout",
  "runtime_conflict",
  "invalid_launch",
] as const;
export type RuntimeErrorCode = (typeof runtimeErrorCodes)[number];
export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}
export type RuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeError };

export const retirementReasons = {
  target_rejected: "回收目标未通过路由校验或连接失败",
  unsupported: "运行时不支持空闲回收",
  hc_failed: "hc 请求未成功",
  identity_changed: "终端身份或启动代次不匹配",
  kept_terminal: "终端在程序退出后会保留 shell",
  terminal_not_live: "hc 未报告终端存活或已结束",
  missing_pid: "hc 未返回有效的终端进程号",
  missing_creation_time: "hc 未返回有效的终端创建时刻",
  pidfd_unavailable: "执行端不支持 pidfd",
  permission_denied: "执行端拒绝读取或操作目标进程",
  marker_mismatch: "进程的 hc 终端标记不匹配",
  process_gone: "探测时原进程已消失，尚未确认终端退出",
  probe_invalid: "未取得有效的进程身份证明",
  guard_changed: "发信号前空闲资格已改变",
  still_live: "等待结束后终端仍存活",
  confirmation_pending: "尚未确认原会话退出",
} as const;

/** Only structured, bounded facts may cross the runtime/host boundary. */
export type RetirementEvidence = {
  readonly reason: keyof typeof retirementReasons;
  readonly stage: "target" | "get" | "probe" | "HUP" | "TERM" | "confirm";
  readonly terminal_state?: "live" | "finished" | "other";
  readonly runtime_code?: RuntimeErrorCode;
  readonly hc_kind?: string;
  readonly exit_code?: number;
  readonly observation?: "alive" | "exited" | "unknown" | RuntimeErrorCode;
};
export type IdleRetirementResult =
  | { readonly outcome: "exited" }
  | {
      readonly outcome: "withdrawn" | "timeout" | "uncertain";
      readonly evidence: RetirementEvidence;
    };

/** These are properties of this terminal/platform. Do not keep retrying signals. */
export const retirementObserveOnly = (evidence?: RetirementEvidence) =>
  evidence !== undefined &&
  ["kept_terminal", "pidfd_unavailable", "unsupported"].includes(
    evidence.reason,
  );

export type RetirementSettlement =
  | IdleRetirementResult
  | { readonly outcome: "observing"; readonly evidence: RetirementEvidence };
